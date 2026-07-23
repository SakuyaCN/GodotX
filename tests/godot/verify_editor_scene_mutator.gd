extends SceneTree

const EditorSceneMutator := preload("res://addons/godetx/editor_scene_mutator.gd")

class TypedArrayNode:
	extends Node
	@export var values: Array[int] = []

class CustomResourceMetadataNode:
	extends Node
	var custom_resource: Resource

	func _get_property_list() -> Array[Dictionary]:
		return [{
			"name": "custom_resource",
			"type": TYPE_OBJECT,
			"class_name": "ProjectDefinedResource",
			"hint": PROPERTY_HINT_RESOURCE_TYPE,
			"hint_string": "ProjectDefinedResource",
			"usage": PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_STORAGE,
		}]

	func _get(property: StringName) -> Variant:
		return custom_resource if property == &"custom_resource" else null

	func _set(property: StringName, value: Variant) -> bool:
		if property != &"custom_resource":
			return false
		custom_resource = value as Resource
		return true

var _failures := PackedStringArray()


func _init() -> void:
	var mutator := EditorSceneMutator.new()
	var root := Node2D.new()
	root.name = "Main"
	var title := Label.new()
	title.name = "Title"
	title.text = "Before"
	root.add_child(title)
	title.owner = root
	var sibling := Node.new()
	sibling.name = "Sibling"
	root.add_child(sibling)
	sibling.owner = root
	var doomed := Node.new()
	doomed.name = "Doomed"
	root.add_child(doomed)
	doomed.owner = root
	var doomed_child := Node.new()
	doomed_child.name = "Nested"
	doomed.add_child(doomed_child)
	doomed_child.owner = root

	var undo_redo := UndoRedo.new()
	var scene_id := mutator._scene_id(root)
	var initial_revision := mutator.scene_revision_for(root, undo_redo)
	var invalid := mutator._apply_operations_with_undo(root, {
		"operation_id": "test-invalid",
		"scene_id": scene_id,
		"scene_revision": initial_revision,
		"operations": [
			{
				"action": "add_node",
				"parent_path": ".",
				"node_type": "Label",
				"name": "MustNotExist",
			},
			{
				"action": "set_property",
				"node_path": "Missing",
				"property": "text",
				"value": "invalid",
			},
		],
	}, undo_redo)
	_assert(not bool(invalid.get("ok", true)), "Invalid batches should fail validation")
	_assert(root.get_node_or_null("MustNotExist") == null, "Validation must not partially mutate the scene")
	_assert(not undo_redo.has_undo(), "Invalid batches must not create undo history")
	var add_then_remove := mutator._apply_operations_with_undo(root, {
		"operation_id": "test-add-remove",
		"scene_id": scene_id,
		"scene_revision": initial_revision,
		"operations": [
			{
				"action": "add_node",
				"parent_path": ".",
				"node_type": "Node",
				"name": "Transient",
			},
			{"action": "remove_node", "node_path": "Transient"},
		],
	}, undo_redo)
	_assert(not bool(add_then_remove.get("ok", true)), "Added nodes cannot enter both undo reference lifetimes")
	_assert(root.get_node_or_null("Transient") == null, "Rejected add/remove batches must remain atomic")
	var remove_then_set := mutator._apply_operations_with_undo(root, {
		"operation_id": "test-remove-set",
		"scene_id": scene_id,
		"scene_revision": initial_revision,
		"operations": [
			{"action": "remove_node", "node_path": "Doomed"},
			{
				"action": "set_property",
				"node_path": "Doomed",
				"property": "process_mode",
				"value": 0,
			},
		],
	}, undo_redo)
	_assert(not bool(remove_then_set.get("ok", true)), "Removed nodes must leave the virtual scene immediately")
	_assert(root.get_node_or_null("Doomed") == doomed, "Rejected remove/set batches must not detach nodes")
	_assert(not undo_redo.has_undo(), "Rejected structural batches must not create undo history")
	var decoded_array := mutator._decode_json_value([
		1,
		"two",
		{"godot_type": "Color", "r": 0.25, "g": 0.5, "b": 0.75, "a": 1.0},
	], true, "value")
	_assert(bool(decoded_array.get("ok", false)), "Flat JSON-safe arrays should decode")
	var decoded_values := decoded_array.get("value", []) as Array
	_assert(decoded_values.size() == 3 and decoded_values[2] is Color, "Tagged values should decode inside flat arrays")
	_assert(
		not bool(mutator._decode_json_value([[1]], true, "value").get("ok", true)),
		"Nested arrays should be rejected"
	)
	_assert(
		not bool(mutator._decode_json_value([{
			"godot_type": "NodePath",
			"path": "Sibling",
		}], true, "value").get("ok", true)),
		"NodePath tags inside arrays must not bypass owner-relative conversion"
	)
	_assert(
		not bool(mutator._prepare_property_value(title, "name", "Injected", "value").get("ok", true)),
		"Structural properties should require dedicated operations"
	)
	var enum_value := mutator._prepare_property_value(title, "mouse_filter", 2.0, "value")
	_assert(
		bool(enum_value.get("ok", false)) and enum_value.get("value") is int and int(enum_value.value) == 2,
		"Integral JSON floats should coerce to integer enum properties"
	)
	_assert(
		not bool(mutator._prepare_property_value(title, "mouse_filter", 1.5, "value").get("ok", true)),
		"Fractional JSON numbers must not coerce to integer properties"
	)
	var integer_vector := mutator._decode_tagged_value({
		"godot_type": "Vector2i",
		"x": 12.0,
		"y": -3.0,
	}, "value")
	_assert(
		bool(integer_vector.get("ok", false)) and integer_vector.get("value") == Vector2i(12, -3),
		"Integral JSON floats should decode inside integer vectors"
	)
	var packed_integers := mutator._coerce_packed_array([1.0, 2.0, 3.0], TYPE_PACKED_INT32_ARRAY, "values")
	_assert(
		bool(packed_integers.get("ok", false))
		and packed_integers.get("value") == PackedInt32Array([1, 2, 3]),
		"Integral JSON floats should decode inside packed integer arrays"
	)
	_assert(
		bool(mutator._json_integer(9_007_199_254_740_991.0, "value").get("ok", false))
		and not bool(mutator._json_integer(9_007_199_254_740_992.0, "value").get("ok", true)),
		"Bare JSON integers should stay inside the exact IEEE-754 range"
	)
	_assert(
		not bool(mutator._decode_tagged_value({
			"godot_type": "Vector2i",
			"x": 2147483648.0,
			"y": 0.0,
		}, "value").get("ok", true)),
		"Integer vectors should reject signed 32-bit overflow"
	)
	var packed_bytes := mutator._coerce_packed_array([0.0, 255.0], TYPE_PACKED_BYTE_ARRAY, "bytes")
	_assert(
		bool(packed_bytes.get("ok", false))
		and packed_bytes.get("value") == PackedByteArray([0, 255]),
		"Packed bytes should accept their inclusive bounds"
	)
	_assert(
		not bool(mutator._coerce_packed_array([-1.0], TYPE_PACKED_BYTE_ARRAY, "bytes").get("ok", true))
		and not bool(mutator._coerce_packed_array([256.0], TYPE_PACKED_BYTE_ARRAY, "bytes").get("ok", true))
		and not bool(mutator._coerce_packed_array([1.5], TYPE_PACKED_BYTE_ARRAY, "bytes").get("ok", true)),
		"Packed bytes should reject overflow and fractional values"
	)
	_assert(
		not bool(mutator._coerce_packed_array([2147483648.0], TYPE_PACKED_INT32_ARRAY, "values").get("ok", true)),
		"Packed int32 arrays should reject overflow"
	)
	_assert(
		bool(mutator._decode_tagged_value({
			"godot_type": "int64",
			"value": "9223372036854775807",
		}, "value").get("ok", false))
		and not bool(mutator._decode_tagged_value({
			"godot_type": "int64",
			"value": "9223372036854775808",
		}, "value").get("ok", true)),
		"Tagged int64 values should enforce their exact decimal range"
	)
	var texture_rect := TextureRect.new()
	var texture_value := mutator._prepare_property_value(texture_rect, "texture", {
		"godot_type": "Resource",
		"path": "res://addons/godetx/icons/godotx-mark.png",
		"expected_type": "Texture2D",
	}, "value")
	_assert(
		bool(texture_value.get("ok", false)) and texture_value.get("value") is Texture2D,
		"Resource tags should load project resources compatible with the property hint"
	)
	_assert(
		not bool(mutator._decode_tagged_value({
			"godot_type": "Resource",
			"path": "res://../outside.png",
		}, "value").get("ok", true)),
		"Resource tags must reject traversal paths"
	)
	_assert(
		mutator._resource_path_error("res://%s.png" % "a".repeat(600)).is_empty(),
		"Resource paths up to the Runtime's 1024-character limit should pass syntax validation"
	)
	texture_rect.free()
	var typed_array_node := TypedArrayNode.new()
	_assert(
		not bool(mutator._prepare_property_value(typed_array_node, "values", [1, 2], "value").get("ok", true)),
		"Typed Array properties must fail before an UndoRedo action is committed"
	)
	typed_array_node.free()
	_assert(
		mutator._script_resource_property_error({
			"class_name": "ProjectDefinedResource",
			"hint": PROPERTY_HINT_RESOURCE_TYPE,
		}) == "ProjectDefinedResource",
		"Script Resource property types must be reported as unsupported"
	)
	var custom_resource_node := CustomResourceMetadataNode.new()
	_assert(
		bool(mutator._prepare_property_value(custom_resource_node, "custom_resource", null, "value").get("ok", false)),
		"Custom Resource properties should still allow null clearing"
	)
	_assert(
		not bool(mutator._prepare_property_value(custom_resource_node, "custom_resource", "unsupported", "value").get("ok", true)),
		"Non-null custom Resource assignment should fail during prevalidation"
	)
	custom_resource_node.free()
	_test_node_path_final_tree(mutator, false)
	_test_node_path_final_tree(mutator, true)
	_test_multiple_node_path_sets(mutator)
	_test_ordered_virtual_children(mutator)
	_test_internal_child_external_index(mutator)
	_test_duplicate_instance_boundary(mutator)
	_test_result_codec(mutator)
	_test_set_script_operation(mutator)

	var arguments := {
		"operation_id": "test-live-scene-action",
		"scene_id": scene_id,
		"scene_revision": initial_revision,
		"operations": [
			{
				"action": "duplicate_node",
				"node_path": "Title",
				"parent_path": ".",
				"name": "TitleCopy",
			},
			{
				"action": "add_node",
				"parent_path": ".",
				"node_type": "Label",
				"name": "AgentLabel",
				"properties": {
					"text": "Added",
					"position": {"godot_type": "Vector2", "x": 12.0, "y": 34.0},
					"mouse_filter": 2.0,
				},
			},
			{
				"action": "add_node",
				"parent_path": ".",
				"node_type": "RemoteTransform2D",
				"name": "Remote",
				"properties": {
					"remote_path": {"godot_type": "NodePath", "path": "."},
				},
			},
			{
				"action": "set_property",
				"node_path": "Title",
				"property": "text",
				"value": "Changed",
			},
			{
				"action": "rename_node",
				"node_path": "Title",
				"new_name": "标题",
			},
			{
				"action": "reparent_node",
				"node_path": "Sibling",
				"new_parent_path": "AgentLabel",
				"index": 0,
				"keep_global_transform": true,
			},
			{
				"action": "instantiate_scene",
				"parent_path": ".",
				"scene_path": "res://demo/icon.tscn",
				"name": "InstancedIcon",
				"properties": {
					"texture": {
						"godot_type": "Resource",
						"path": "res://addons/godetx/icons/godotx-mark.png",
						"expected_type": "Texture2D",
					},
				},
			},
			{"action": "remove_node", "node_path": "Doomed"},
		],
	}
	var committed := mutator._apply_operations_with_undo(root, arguments, undo_redo)
	_assert(bool(committed.get("ok", false)), "Valid batches should commit")
	_assert(int(committed.get("change_count", 0)) == 8, "Commit should return structured changes")
	_assert(int(committed.get("operation_count", 0)) == 8, "Commit should report the operation count")
	_assert(not str(committed.get("undo_action", "")).is_empty(), "Commit should name its undo action")
	_assert(root.get_node_or_null("AgentLabel") is Label, "Commit should add the requested node")
	_assert(root.get_node_or_null("TitleCopy") is Label, "Commit should duplicate a node")
	var added := root.get_node_or_null("AgentLabel") as Label
	if added != null:
		_assert(added.text == "Added", "Add-node properties should be applied")
		_assert(added.position == Vector2(12, 34), "Tagged vectors should be decoded")
		_assert(added.mouse_filter == Control.MOUSE_FILTER_IGNORE, "Integer enum properties should be applied")
		_assert(added.owner == root, "Added nodes should be owned by the edited scene")
	var renamed := root.get_node_or_null("标题") as Label
	_assert(renamed != null and renamed.text == "Changed", "Set and rename operations should commit in order")
	var remote := root.get_node_or_null("Remote") as RemoteTransform2D
	_assert(remote != null and remote.remote_path == NodePath(".."), "NodePath targets should become owner-relative")
	_assert(root.get_node_or_null("AgentLabel/Sibling") == sibling, "Commit should reparent a node")
	var instanced_icon := root.get_node_or_null("InstancedIcon") as TextureRect
	_assert(instanced_icon != null and instanced_icon.texture is Texture2D, "Commit should instantiate scenes and assign resources")
	_assert(root.get_node_or_null("Doomed") == null, "Commit should remove the requested node")

	var replayed := mutator._apply_operations_with_undo(root, arguments, undo_redo)
	_assert(bool(replayed.get("ok", false)) and bool(replayed.get("replayed", false)), "Duplicate operation IDs should replay")
	var conflicting_arguments: Dictionary = arguments.duplicate(true)
	var conflicting_operations: Array = conflicting_arguments.get("operations", [])
	var conflicting_add: Dictionary = conflicting_operations[0]
	conflicting_add["name"] = "DifferentAgentLabel"
	var conflicting := mutator._apply_operations_with_undo(root, conflicting_arguments, undo_redo)
	_assert(not bool(conflicting.get("ok", true)), "An operation ID cannot be reused for different operations")
	var other_root := Node2D.new()
	other_root.name = "OtherMain"
	var stale_replay := mutator._apply_operations_with_undo(other_root, arguments, UndoRedo.new())
	_assert(not bool(stale_replay.get("ok", true)), "A replay must still reject a changed current scene")
	other_root.free()

	_assert(undo_redo.undo(), "Committed batches should be undoable")
	_assert(root.get_node_or_null("AgentLabel") == null, "Undo should remove newly added nodes")
	_assert(root.get_node_or_null("TitleCopy") == null, "Undo should remove duplicated nodes")
	_assert(root.get_node_or_null("Remote") == null, "Undo should remove NodePath-bearing new nodes")
	_assert(root.get_node_or_null("InstancedIcon") == null, "Undo should remove instantiated scenes")
	_assert(root.get_node_or_null("Sibling") == sibling, "Undo should restore reparented nodes")
	var restored_title := root.get_node_or_null("Title") as Label
	_assert(restored_title != null and restored_title.text == "Before", "Undo should restore renamed properties")
	var restored_doomed := root.get_node_or_null("Doomed")
	_assert(restored_doomed == doomed, "Undo should restore removed node identity")
	_assert(doomed.get_index() == 2, "Undo should restore the original sibling index")
	_assert(doomed.owner == root and doomed_child.owner == root, "Undo should restore subtree owners")
	var replay_after_undo := mutator._apply_operations_with_undo(root, arguments, undo_redo)
	_assert(
		not bool(replay_after_undo.get("ok", true)),
		"A journal replay must not report success after its applied state was undone"
	)

	_assert(undo_redo.redo(), "Undone batches should be redoable")
	_assert(root.get_node_or_null("AgentLabel") is Label, "Redo should add the node again")
	_assert(root.get_node_or_null("TitleCopy") is Label, "Redo should duplicate the node again")
	_assert(root.get_node_or_null("AgentLabel/Sibling") == sibling, "Redo should reparent the node again")
	_assert(root.get_node_or_null("InstancedIcon") is TextureRect, "Redo should instantiate the scene again")
	_assert(root.get_node_or_null("标题") is Label, "Redo should rename the node again")
	_assert(root.get_node_or_null("Doomed") == null, "Redo should remove the node again")

	undo_redo.undo()
	root.free()
	if not _failures.is_empty():
		for failure in _failures:
			printerr(failure)
		quit(1)
		return
	print("GODETX_EDITOR_SCENE_MUTATOR_OK")
	quit(0)


func _test_node_path_final_tree(mutator: EditorSceneMutator, structural_first: bool) -> void:
	var root := Node2D.new()
	root.name = "PathRoot"
	var group := Node2D.new()
	group.name = "Group"
	root.add_child(group)
	group.owner = root
	var source := RemoteTransform2D.new()
	source.name = "Source"
	root.add_child(source)
	source.owner = root
	var target := Node2D.new()
	target.name = "Target"
	root.add_child(target)
	target.owner = root
	var structural_operations: Array = [
		{"action": "rename_node", "node_path": "Target", "new_name": "Renamed"},
		{
			"action": "reparent_node",
			"node_path": "Source",
			"new_parent_path": "Group",
			"index": 0,
		},
		{"action": "rename_node", "node_path": "Group", "new_name": "Container"},
	]
	var path_operation := {
		"action": "set_property",
		"node_path": "Source" if not structural_first else "Container/Source",
		"property": "remote_path",
		"value": {
			"godot_type": "NodePath",
			"path": "Target" if not structural_first else "Renamed",
		},
	}
	var operations: Array = []
	if structural_first:
		operations.append_array(structural_operations)
		operations.append(path_operation)
	else:
		operations.append(path_operation)
		operations.append_array(structural_operations)
	var undo_redo := UndoRedo.new()
	var result: Dictionary = mutator._apply_operations_with_undo(root, {
		"operation_id": "test-path-structural-first" if structural_first else "test-path-property-first",
		"scene_id": mutator._scene_id(root),
		"scene_revision": mutator.scene_revision_for(root, undo_redo),
		"operations": operations,
	}, undo_redo)
	_assert(bool(result.get("ok", false)), "Deferred NodePath batches should commit in either operation order")
	_assert(
		source.get_parent() == group and source.remote_path == NodePath("../../Renamed"),
		"NodePath must use the final virtual tree regardless of operation order"
	)
	var set_change := _find_change(result.get("changes", []), "set_property")
	var reparent_change := _find_change(result.get("changes", []), "reparent_node")
	_assert(str(set_change.get("node_path", "")) == "Container/Source", "Set-property logs should use the committed node path")
	var encoded_after := set_change.get("after", {}) as Dictionary
	_assert(
		str(encoded_after.get("godot_type", "")) == "NodePath"
		and str(encoded_after.get("path", "")) == "Renamed",
		"Actual NodePath logs should expose a writable scene-root-relative target"
	)
	_assert(
		str(reparent_change.get("new_path", "")) == "Container/Source"
		and str(reparent_change.get("new_parent_path", "")) == "Container",
		"Reparent logs should use committed node and parent paths"
	)
	_assert(undo_redo.undo(), "Deferred NodePath batches should be undoable")
	_assert(source.get_parent() == root and source.remote_path.is_empty(), "NodePath undo should restore the original state")
	_assert(undo_redo.redo(), "Deferred NodePath batches should be redoable")
	_assert(source.remote_path == NodePath("../../Renamed"), "NodePath redo should restore the final relative path")
	undo_redo.undo()
	root.free()


func _test_multiple_node_path_sets(mutator: EditorSceneMutator) -> void:
	var root := Node2D.new()
	root.name = "MultiPathRoot"
	var group := Node2D.new()
	group.name = "Group"
	root.add_child(group)
	group.owner = root
	var source := RemoteTransform2D.new()
	source.name = "Source"
	root.add_child(source)
	source.owner = root
	var target := Node2D.new()
	target.name = "Target"
	root.add_child(target)
	target.owner = root
	var undo_redo := UndoRedo.new()
	var result: Dictionary = mutator._apply_operations_with_undo(root, {
		"operation_id": "test-multiple-node-path-sets",
		"scene_id": mutator._scene_id(root),
		"scene_revision": mutator.scene_revision_for(root, undo_redo),
		"operations": [
			{
				"action": "set_property",
				"node_path": "Source",
				"property": "remote_path",
				"value": {"godot_type": "NodePath", "path": "Target"},
			},
			{
				"action": "set_property",
				"node_path": "Source",
				"property": "remote_path",
				"value": {"godot_type": "NodePath", "path": "."},
			},
			{"action": "rename_node", "node_path": "Target", "new_name": "Renamed"},
			{"action": "reparent_node", "node_path": "Source", "new_parent_path": "Group", "index": 0},
		],
	}, undo_redo)
	_assert(bool(result.get("ok", false)), "Multiple deferred writes to one NodePath property should commit")
	_assert(source.remote_path == NodePath("../.."), "The last deferred NodePath write should win")
	var changes: Array = result.get("changes", [])
	var second_before: Variant = (changes[1] as Dictionary).get("before", {}) if changes.size() > 1 else {}
	_assert(
		second_before is Dictionary
		and str(second_before.get("godot_type", "")) == "NodePath"
		and str(second_before.get("path", "")) == "Renamed",
		"A later NodePath write should report the earlier deferred value as before"
	)
	var second_after: Dictionary = {}
	if changes.size() > 1:
		second_after = (changes[1] as Dictionary).get("after", {}) as Dictionary
	_assert(
		str(second_after.get("godot_type", "")) == "NodePath" and str(second_after.get("path", "")) == ".",
		"Actual NodePath after values should use scene-root-relative syntax"
	)
	_assert(undo_redo.undo(), "Multiple NodePath writes should undo as one action")
	_assert(source.remote_path.is_empty(), "Undo should restore the value before all deferred writes")
	root.free()


func _test_ordered_virtual_children(mutator: EditorSceneMutator) -> void:
	var root := Node.new()
	root.name = "OrderRoot"
	var nodes := {}
	for child_name in ["A", "B", "C", "D"]:
		var child := Node.new()
		child.name = child_name
		root.add_child(child)
		child.owner = root
		nodes[child_name] = child
	var undo_redo := UndoRedo.new()
	var result: Dictionary = mutator._apply_operations_with_undo(root, {
		"operation_id": "test-ordered-virtual-children",
		"scene_id": mutator._scene_id(root),
		"scene_revision": mutator.scene_revision_for(root, undo_redo),
		"operations": [
			{"action": "reparent_node", "node_path": "A", "new_parent_path": ".", "index": 3},
			{"action": "reparent_node", "node_path": "D", "new_parent_path": ".", "index": 0},
			{"action": "remove_node", "node_path": "B"},
		],
	}, undo_redo)
	_assert(bool(result.get("ok", false)), "Consecutive virtual reorder/reparent/remove operations should commit")
	_assert(_external_child_names(root) == PackedStringArray(["D", "C", "A"]), "Commit should match planned child order")
	_assert(undo_redo.undo(), "Ordered structural batches should be undoable")
	_assert(_external_child_names(root) == PackedStringArray(["A", "B", "C", "D"]), "Undo should restore exact child order")
	_assert(undo_redo.redo(), "Ordered structural batches should be redoable")
	_assert(_external_child_names(root) == PackedStringArray(["D", "C", "A"]), "Redo should restore planned child order")
	undo_redo.undo()
	root.free()


func _test_internal_child_external_index(mutator: EditorSceneMutator) -> void:
	var root := Node.new()
	root.name = "InternalRoot"
	var internal := Node.new()
	internal.name = "Internal"
	root.add_child(internal, false, Node.INTERNAL_MODE_FRONT)
	for child_name in ["A", "B"]:
		var child := Node.new()
		child.name = child_name
		root.add_child(child)
		child.owner = root
	var undo_redo := UndoRedo.new()
	var result: Dictionary = mutator._apply_operations_with_undo(root, {
		"operation_id": "test-internal-reparent-external-index",
		"scene_id": mutator._scene_id(root),
		"scene_revision": mutator.scene_revision_for(root, undo_redo),
		"operations": [
			{"action": "reparent_node", "node_path": "B", "new_parent_path": ".", "index": 0},
		],
	}, undo_redo)
	_assert(bool(result.get("ok", false)), "Reparent index should ignore internal children")
	_assert(_external_child_names(root) == PackedStringArray(["B", "A"]), "External index 0 should move B before A")
	_assert(undo_redo.undo(), "Internal-child reorder should be undoable")
	_assert(_external_child_names(root) == PackedStringArray(["A", "B"]), "Undo should restore external order around internal children")
	_assert(undo_redo.redo(), "Internal-child reorder should be redoable")
	_assert(_external_child_names(root) == PackedStringArray(["B", "A"]), "Redo should preserve external index semantics")
	undo_redo.undo()
	root.free()


func _test_duplicate_instance_boundary(mutator: EditorSceneMutator) -> void:
	var packed := ResourceLoader.load("res://demo/main.tscn", "PackedScene") as PackedScene
	if packed == null:
		_assert(false, "Instance-boundary fixture should load")
		return
	var root := Node.new()
	root.name = "InstanceBoundaryRoot"
	var root_duplicate_undo := UndoRedo.new()
	var root_duplicate: Dictionary = mutator._apply_operations_with_undo(root, {
		"operation_id": "test-reject-scene-root-duplicate",
		"scene_id": mutator._scene_id(root),
		"scene_revision": mutator.scene_revision_for(root, root_duplicate_undo),
		"operations": [
			{"action": "duplicate_node", "node_path": ".", "parent_path": ".", "name": "RootCopy"},
		],
	}, root_duplicate_undo)
	_assert(not bool(root_duplicate.get("ok", true)), "The current scene root must never be duplicated")
	_assert(not root_duplicate_undo.has_undo(), "Rejected scene-root duplication must not create undo history")
	var instance := packed.instantiate()
	root.add_child(instance)
	instance.owner = root
	var undo_redo := UndoRedo.new()
	var result: Dictionary = mutator._apply_operations_with_undo(root, {
		"operation_id": "test-duplicate-instance-boundary",
		"scene_id": mutator._scene_id(root),
		"scene_revision": mutator.scene_revision_for(root, undo_redo),
		"operations": [
			{"action": "duplicate_node", "node_path": "Main", "parent_path": ".", "name": "MainCopy"},
			{"action": "set_property", "node_path": "MainCopy/Title", "property": "text", "value": "NotPersistent"},
		],
	}, undo_redo)
	_assert(not bool(result.get("ok", true)), "Duplicated instance children must remain non-editable")
	_assert(root.get_node_or_null("MainCopy") == null, "Rejected instance-child edits must remain atomic")
	_assert(not undo_redo.has_undo(), "Rejected instance-child edits must not create undo history")
	root.free()


func _test_result_codec(mutator: EditorSceneMutator) -> void:
	var integer_budget: Dictionary = mutator._new_change_budget()
	var encoded_integer: Variant = mutator._encode_change_value(9_007_199_254_740_992, integer_budget)
	_assert(
		encoded_integer is Dictionary
		and str(encoded_integer.get("godot_type", "")) == "int64"
		and str(encoded_integer.get("value", "")) == "9007199254740992",
		"Change results should tag integers outside JavaScript's exact range"
	)
	var packed_budget: Dictionary = mutator._new_change_budget()
	var encoded_packed: Variant = mutator._encode_change_value(
		PackedInt64Array([9_007_199_254_740_992]),
		packed_budget
	)
	_assert(
		encoded_packed is Array
		and encoded_packed.size() == 1
		and encoded_packed[0] is Dictionary
		and str(encoded_packed[0].get("godot_type", "")) == "int64",
		"Packed integer arrays should recursively use int64 tags"
	)
	var stored_resource: Variant = mutator._encode_change_value(Resource.new(), mutator._new_change_budget())
	_assert(
		stored_resource is Dictionary
		and str(stored_resource.get("godot_type", "")) == "StoredResource"
		and not bool(stored_resource.get("writable", true)),
		"Built-in resources without a canonical path must not look writable"
	)
	var stored_path: Variant = mutator._encode_change_value(
		NodePath("../Target"),
		mutator._new_change_budget(),
		null,
		null,
		true
	)
	_assert(
		stored_path is Dictionary
		and str(stored_path.get("godot_type", "")) == "StoredNodePath"
		and not bool(stored_path.get("writable", true)),
		"Stored NodePath values without owner context must not look writable"
	)
	var stored_vector: Variant = mutator._encode_change_value(
		Vector4(NAN, INF, -INF, 1.0),
		mutator._new_change_budget()
	)
	_assert(
		stored_vector is Dictionary
		and str(stored_vector.get("godot_type", "")) == "Vector4"
		and stored_vector.get("x") is Dictionary
		and str(stored_vector.x.get("godot_type", "")) == "StoredFloat"
		and str(stored_vector.y.get("value", "")) == "inf"
		and str(stored_vector.z.get("value", "")) == "-inf"
		and JSON.stringify(stored_vector).find(":null") < 0,
		"Composite float values must preserve NaN and infinity without JSON null coercion"
	)

	var root := Node.new()
	root.name = "CodecRoot"
	var label := Label.new()
	label.name = "LargeText"
	label.text = "x".repeat(500_000)
	root.add_child(label)
	label.owner = root
	var undo_redo := UndoRedo.new()
	var result: Dictionary = mutator._apply_operations_with_undo(root, {
		"operation_id": "test-bounded-change-result",
		"scene_id": mutator._scene_id(root),
		"scene_revision": mutator.scene_revision_for(root, undo_redo),
		"operations": [{
			"action": "set_property",
			"node_path": "LargeText",
			"property": "text",
			"value": "small",
		}],
	}, undo_redo)
	_assert(bool(result.get("ok", false)), "Large before values must not make a committed change report fail")
	_assert(
		JSON.stringify(result.get("changes", [])).length() <= 256 * 1024,
		"Final change logs must stay within the shared result budget"
	)
	var change := _find_change(result.get("changes", []), "set_property")
	var encoded_before := change.get("before", {}) as Dictionary
	_assert(
		bool(encoded_before.get("truncated", false))
		and int(encoded_before.get("original_size", 0)) == 500_000,
		"Large strings should use a structured truncation marker"
	)
	_assert(undo_redo.undo(), "Bounded result encoding must not affect UndoRedo")
	_assert(label.text.length() == 500_000, "Undo should restore the full value, not the log preview")
	root.free()


func _test_set_script_operation(mutator: EditorSceneMutator) -> void:
	var scene_root := Node.new()
	scene_root.name = "ScriptRoot"
	var label := Label.new()
	label.name = "PlainLabel"
	scene_root.add_child(label)
	label.owner = scene_root
	var undo_redo := UndoRedo.new()
	var scene_id := EditorSceneMutator._scene_id(scene_root)
	var incompatible := mutator._apply_operations_with_undo(scene_root, {
		"operation_id": "test-set-script-incompatible",
		"scene_id": scene_id,
		"scene_revision": EditorSceneMutator.scene_revision_for(scene_root, undo_redo),
		"operations": [{
			"action": "set_script",
			"node_path": "PlainLabel",
			"script_path": "res://tests/godot/editor_scene_node2d_script.gd",
		}],
	}, undo_redo)
	_assert(not bool(incompatible.get("ok", true)), "Incompatible script base types should be rejected")
	_assert(label.get_script() == null, "Rejected set_script operations must not change the node")
	_assert(not undo_redo.has_undo(), "Rejected set_script operations must not create undo history")

	var result: Dictionary = mutator._apply_operations_with_undo(scene_root, {
		"operation_id": "test-set-script",
		"scene_id": scene_id,
		"scene_revision": EditorSceneMutator.scene_revision_for(scene_root, undo_redo),
		"operations": [
			{
				"action": "add_node",
				"parent_path": ".",
				"node_type": "Node",
				"name": "Scripted",
			},
			{
				"action": "set_script",
				"node_path": "Scripted",
				"script_path": "res://tests/godot/editor_scene_test_script.gd",
			},
		],
	}, undo_redo)
	_assert(bool(result.get("ok", false)), "set_script should commit as a dedicated live scene operation")
	var scripted := scene_root.get_node_or_null("Scripted")
	_assert(scripted != null and scripted.get_script() is Script, "set_script should attach the requested script")
	if scripted != null and scripted.get_script() is Script:
		_assert(
			(scripted.get_script() as Script).resource_path == "res://tests/godot/editor_scene_test_script.gd",
			"set_script should preserve the script resource path in the node"
		)
	var script_change := _find_change(result.get("changes", []), "set_script")
	_assert(
		str(script_change.get("after", "")) == "res://tests/godot/editor_scene_test_script.gd",
		"set_script change logs should report the attached script path"
	)
	_assert(undo_redo.undo(), "set_script batches should be undoable")
	_assert(scene_root.get_node_or_null("Scripted") == null, "Undo should remove a newly scripted node")
	_assert(undo_redo.redo(), "set_script batches should be redoable")
	scripted = scene_root.get_node_or_null("Scripted")
	_assert(scripted != null and scripted.get_script() is Script, "Redo should restore the attached script")

	var detached := mutator._apply_operations_with_undo(scene_root, {
		"operation_id": "test-set-script-detach",
		"scene_id": scene_id,
		"scene_revision": EditorSceneMutator.scene_revision_for(scene_root, undo_redo),
		"operations": [{
			"action": "set_script",
			"node_path": "Scripted",
			"script_path": null,
		}],
	}, undo_redo)
	_assert(bool(detached.get("ok", false)), "set_script should allow null to detach scripts")
	scripted = scene_root.get_node_or_null("Scripted")
	_assert(scripted != null and scripted.get_script() == null, "Null set_script should detach the script")
	scene_root.free()


func _external_child_names(parent: Node) -> PackedStringArray:
	var names := PackedStringArray()
	for child in parent.get_children(false):
		names.append(str(child.name))
	return names


func _find_change(changes: Array, action: String) -> Dictionary:
	for change_value in changes:
		if change_value is Dictionary and str(change_value.get("action", "")) == action:
			return change_value
	return {}


func _assert(condition: bool, message: String) -> void:
	if not condition:
		_failures.append(message)
