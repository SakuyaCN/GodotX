@tool
class_name GodetXEditorSceneMutator
extends RefCounted

const TOOL_NAME := "scene_apply_operations"
const MAX_OPERATIONS := 64
const MAX_ADD_PROPERTIES := 64
const MAX_ARRAY_ITEMS := 256
const MAX_PROPERTY_SCAN := 2048
const MAX_OWNER_SNAPSHOT_NODES := 4096
const MAX_DUPLICATE_NODES := 4096
const MAX_NODE_NAME_LENGTH := 128
const MAX_PROPERTY_NAME_LENGTH := 256
const MAX_NODE_PATH_LENGTH := 512
const MAX_RESOURCE_PATH_LENGTH := 1024
const MAX_STRING_LENGTH := 16384
const MAX_OPERATION_ID_LENGTH := 256
const MAX_JOURNAL_ENTRIES := 128
const MAX_CHANGE_RESULT_CHARS := 256 * 1024
const MAX_CHANGE_VALUE_COUNT := 4096
const MAX_CHANGE_VALUE_CHARS := 128 * 1024
const MAX_CHANGE_STRING_CHARS := 16 * 1024
const MAX_CHANGE_ARRAY_ITEMS := 128
const MAX_CHANGE_DEPTH := 4
# The Runtime caps the normalized change at 512 KiB before adding its operation ID.
const MAX_REQUEST_BYTES := 512 * 1024 + 4096
const JSON_SAFE_INTEGER_MAX := 9_007_199_254_740_991

const BLOCKED_PROPERTIES := {
	"name": true,
	"owner": true,
	"script": true,
	"scene_file_path": true,
	"scene_unique_id": true,
	"unique_name_in_owner": true,
}

const RESOURCE_TAG := "Resource"
const NODE_PATH_TAG := "NodePath"

var editor_interface: EditorInterface
var editor_undo_redo: EditorUndoRedoManager
var _operation_journal: Dictionary = {}
var _operation_order: Array[String] = []


func _init(
	value: EditorInterface = null,
	undo_redo_value: EditorUndoRedoManager = null
) -> void:
	editor_interface = value
	editor_undo_redo = undo_redo_value


func execute(tool: String, args: Dictionary, scene_root_override: Node = null) -> Dictionary:
	if tool != TOOL_NAME:
		return _error("Unknown editor mutation tool: %s" % tool)
	if editor_interface == null:
		return _error("EditorInterface is unavailable")
	var scene_root := (
		scene_root_override
		if scene_root_override != null
		else editor_interface.get_edited_scene_root()
	)
	if scene_root == null or not is_instance_valid(scene_root):
		return _error("No scene is currently open in the editor")
	var undo_redo: EditorUndoRedoManager = editor_undo_redo
	if undo_redo == null:
		undo_redo = EditorInterface.get_editor_undo_redo()
	if undo_redo == null:
		return _error("Editor undo/redo manager is unavailable")
	return _apply_operations_with_undo(scene_root, args, undo_redo)


func _apply_operations_with_undo(scene_root: Node, args: Dictionary, undo_redo) -> Dictionary:
	if scene_root == null or not is_instance_valid(scene_root):
		return _error("Scene root is unavailable")
	if not (undo_redo is EditorUndoRedoManager or undo_redo is UndoRedo):
		return _error("A compatible undo/redo object is required")
	if JSON.stringify(args).to_utf8_buffer().size() > MAX_REQUEST_BYTES:
		return _error("scene mutation request exceeds the %d byte limit" % MAX_REQUEST_BYTES)

	var operation_id_value = args.get("operation_id")
	if not operation_id_value is String:
		return _error("operation_id must be a string")
	var operation_id: String = operation_id_value
	if not _is_safe_operation_id(operation_id):
		return _error("operation_id is empty, too long, or contains unsupported characters")
	var requested_scene_id_value = args.get("scene_id")
	if not requested_scene_id_value is String or requested_scene_id_value.is_empty():
		return _error("scene_id is required")
	var requested_scene_id: String = requested_scene_id_value
	var unknown_top_level := _first_unknown_key(
		args,
		["operation_id", "scene_id", "scene_revision", "operations"]
	)
	if not unknown_top_level.is_empty():
		return _error("Unsupported scene mutation argument: %s" % unknown_top_level)
	var current_scene_id := _scene_id(scene_root)
	if requested_scene_id != current_scene_id:
		return _error("The current scene changed after it was inspected")
	var requested_revision_value = args.get("scene_revision")
	if not requested_revision_value is String or requested_revision_value.is_empty():
		return _error("scene_revision is required")
	var requested_revision: String = requested_revision_value

	var operations_value = args.get("operations")
	if not operations_value is Array:
		return _error("operations must be an array")
	var operations: Array = operations_value
	if operations.is_empty():
		return _error("operations must not be empty")
	if operations.size() > MAX_OPERATIONS:
		return _error("operations exceeds the %d item limit" % MAX_OPERATIONS)

	var current_revision := scene_revision_for(scene_root, undo_redo)
	if _operation_journal.has(operation_id):
		var journal_entry: Dictionary = _operation_journal[operation_id]
		if str(journal_entry.get("scene_id", "")) != requested_scene_id:
			return _error("operation_id was already used for a different scene")
		if journal_entry.get("operations", []) != operations:
			return _error("operation_id was already used for different scene operations")
		if str(journal_entry.get("scene_revision", "")) != requested_revision:
			return _error("operation_id was already used with a different scene revision")
		if current_revision != str(journal_entry.get("result_revision", "")):
			return _error("operation_id result is no longer the current scene state")
		var replayed: Dictionary = (journal_entry.get("result", {}) as Dictionary).duplicate(true)
		replayed["replayed"] = true
		return replayed
	if requested_revision != current_revision:
		return _error("The current scene was modified after it was inspected")

	var root_state := {
		"node": scene_root,
		"parent_node": null,
		"name": str(scene_root.name),
		"removed": false,
		"is_new": false,
		"owner": scene_root.owner,
		"property_values": {},
		"internal": false,
		"editable": true,
	}
	var states := {scene_root.get_instance_id(): root_state}
	var context := {
		"scene_root": scene_root,
		"states": states,
		"child_orders": {},
		"new_nodes": [],
		"removed_roots": [],
		"do_steps": [],
		"undo_groups": [],
		"do_references": [],
		"undo_references": [],
		"changes": [],
		"resources": [],
		"pending_node_paths": [],
		"operation_index": -1,
	}

	for index in range(operations.size()):
		context.operation_index = index
		var operation_value = operations[index]
		if not operation_value is Dictionary:
			_free_uncommitted_nodes(context.new_nodes)
			return _operation_error(index, "operation must be an object")
		var validation := _validate_operation(operation_value, index, context)
		if not bool(validation.get("ok", false)):
			_free_uncommitted_nodes(context.new_nodes)
			return validation
	var node_path_result := _resolve_pending_node_paths(context)
	if not bool(node_path_result.get("ok", false)):
		_free_uncommitted_nodes(context.new_nodes)
		return node_path_result
	if not is_instance_valid(scene_root):
		_free_uncommitted_nodes(context.new_nodes)
		return _error("The edited scene became unavailable during validation")
	if editor_interface != null:
		var scene_still_open := false
		for open_root_value in editor_interface.get_open_scene_roots():
			if open_root_value == scene_root:
				scene_still_open = true
				break
		if not scene_still_open:
			_free_uncommitted_nodes(context.new_nodes)
			return _error("The target scene was closed during mutation validation")
	if scene_revision_for(scene_root, undo_redo) != requested_revision:
		_free_uncommitted_nodes(context.new_nodes)
		return _error("The current scene was modified during mutation validation")

	var action_name := "GodotX: Apply %d live scene change%s" % [
		operations.size(),
		"" if operations.size() == 1 else "s",
	]
	_commit_plan(undo_redo, scene_root, action_name, context)
	var finalized_changes := _finalize_changes(context)
	var result := {
		"ok": true,
		"operation_id": operation_id,
		"scene_id": current_scene_id,
		"scene_path": scene_root.scene_file_path,
		"action_name": action_name,
		"undo_action": action_name,
		"operation_count": operations.size(),
		"scene_revision": scene_revision_for(scene_root, undo_redo),
		"previous_scene_revision": requested_revision,
		"change_count": finalized_changes.size(),
		"changes": finalized_changes,
		"replayed": false,
	}
	_remember_result(operation_id, current_scene_id, requested_revision, operations, result)
	return result


func _validate_operation(operation: Dictionary, index: int, context: Dictionary) -> Dictionary:
	var action_value = operation.get("action")
	if not action_value is String:
		return _operation_error(index, "action must be a string")
	match action_value:
		"add_node":
			return _validate_add_node(operation, index, context)
		"set_property":
			return _validate_set_property(operation, index, context)
		"set_script":
			return _validate_set_script(operation, index, context)
		"rename_node":
			return _validate_rename_node(operation, index, context)
		"remove_node":
			return _validate_remove_node(operation, index, context)
		"duplicate_node":
			return _validate_duplicate_node(operation, index, context)
		"reparent_node":
			return _validate_reparent_node(operation, index, context)
		"instantiate_scene":
			return _validate_instantiate_scene(operation, index, context)
		_:
			return _operation_error(index, "unsupported action: %s" % action_value)


func _validate_add_node(operation: Dictionary, index: int, context: Dictionary) -> Dictionary:
	var unknown := _first_unknown_key(
		operation,
		["action", "parent_path", "node_type", "name", "properties"]
	)
	if not unknown.is_empty():
		return _operation_error(index, "unsupported field: %s" % unknown)
	var parent_path_value = operation.get("parent_path")
	var node_type_value = operation.get("node_type")
	var name_value = operation.get("name")
	if not parent_path_value is String:
		return _operation_error(index, "parent_path must be a string")
	if not node_type_value is String or not _is_ascii_identifier(node_type_value):
		return _operation_error(index, "node_type must be a built-in class identifier")
	if not name_value is String:
		return _operation_error(index, "name must be a string")
	var name_error := _node_name_error(name_value)
	if not name_error.is_empty():
		return _operation_error(index, "invalid node name: %s" % name_error)
	var parent_result := _resolve_virtual_node(parent_path_value, "parent_path", context)
	if not bool(parent_result.get("ok", false)):
		return _operation_error(index, str(parent_result.error))
	var parent := parent_result.node as Node
	if not _is_directly_editable_node(parent, context):
		return _operation_error(index, "parent_path is inside a non-editable instanced subscene")
	if _find_virtual_child(parent, name_value, context, true) != null:
		return _operation_error(index, "a child named %s already exists under %s" % [name_value, parent_path_value])

	var node_type := StringName(node_type_value)
	if (
		not ClassDB.class_exists(node_type)
		or ClassDB.class_get_api_type(node_type) != ClassDB.API_CORE
		or not ClassDB.can_instantiate(node_type)
		or (node_type_value != "Node" and not ClassDB.is_parent_class(node_type, &"Node"))
	):
		return _operation_error(index, "node_type is not an instantiable built-in Node class: %s" % node_type_value)
	var instance = ClassDB.instantiate(node_type)
	if not instance is Node:
		if instance is Object and is_instance_valid(instance):
			instance.free()
		return _operation_error(index, "node_type did not instantiate a Node: %s" % node_type_value)
	var node: Node = instance
	node.name = StringName(name_value)
	context.new_nodes.append(node)
	var state := {
		"node": node,
		"parent_node": parent,
		"name": name_value,
		"removed": false,
		"is_new": true,
		"owner": context.scene_root,
		"property_values": {},
		"internal": false,
		"editable": true,
	}
	context.states[node.get_instance_id()] = state
	_virtual_append_child(parent, node, context)

	var properties_value = operation.get("properties", {})
	if not properties_value is Dictionary:
		return _operation_error(index, "properties must be an object")
	var properties: Dictionary = properties_value
	if properties.size() > MAX_ADD_PROPERTIES:
		return _operation_error(index, "properties exceeds the %d item limit" % MAX_ADD_PROPERTIES)
	var property_names: Array = properties.keys()
	for property_key in property_names:
		if not property_key is String:
			return _operation_error(index, "property names must be strings")
	property_names.sort()
	var prepared_properties: Array = []
	for property_name_value in property_names:
		var prepared := _prepare_property_value(
			node,
			property_name_value,
			properties[property_name_value],
			"properties.%s" % property_name_value,
			context
		)
		if not bool(prepared.get("ok", false)):
			return _operation_error(index, str(prepared.error))
		prepared_properties.append({"name": property_name_value, "value": prepared.value})
		state.property_values[property_name_value] = prepared.value

	var do_steps: Array = context.do_steps
	do_steps.append(_method_step(parent, &"add_child", [node, true]))
	do_steps.append(_property_step(node, &"owner", context.scene_root))
	for prepared in prepared_properties:
		do_steps.append(_property_step(node, StringName(prepared.name), prepared.value))
	context.undo_groups.append([_method_step(parent, &"remove_child", [node])])
	context.do_references.append(node)
	var new_path := _virtual_path(node, context)
	context.changes.append({
		"index": index,
		"action": "add_node",
		"parent_path": parent_path_value,
		"node_path": new_path,
		"node_type": node_type_value,
		"name": name_value,
		"properties": property_names,
		"_node": node,
	})
	return {"ok": true}


func _validate_set_property(operation: Dictionary, index: int, context: Dictionary) -> Dictionary:
	var unknown := _first_unknown_key(operation, ["action", "node_path", "property", "value"])
	if not unknown.is_empty():
		return _operation_error(index, "unsupported field: %s" % unknown)
	var node_path_value = operation.get("node_path")
	var property_value = operation.get("property")
	if not node_path_value is String:
		return _operation_error(index, "node_path must be a string")
	if not property_value is String:
		return _operation_error(index, "property must be a string")
	if not operation.has("value"):
		return _operation_error(index, "value is required")
	var node_result := _resolve_virtual_node(node_path_value, "node_path", context)
	if not bool(node_result.get("ok", false)):
		return _operation_error(index, str(node_result.error))
	var node := node_result.node as Node
	if not _is_directly_editable_node(node, context):
		return _operation_error(index, "node_path is inside a non-editable instanced subscene")
	var prepared := _prepare_property_value(node, property_value, operation.value, "value", context)
	if not bool(prepared.get("ok", false)):
		return _operation_error(index, str(prepared.error))
	var state := _state_for_existing(node, context)
	var old_value = (
		state.property_values[property_value]
		if state.property_values.has(property_value)
		else node.get(StringName(property_value))
	)
	context.do_steps.append(_property_step(node, StringName(property_value), prepared.value))
	context.undo_groups.append([_property_step(node, StringName(property_value), old_value)])
	state.property_values[property_value] = prepared.value
	context.changes.append({
		"index": index,
		"action": "set_property",
		"node_path": _virtual_path(node, context),
		"property": property_value,
		"value_type": type_string(typeof(prepared.value)),
		"_node": node,
		"_property": property_value,
		"_before": old_value,
	})
	return {"ok": true}


func _validate_set_script(operation: Dictionary, index: int, context: Dictionary) -> Dictionary:
	var unknown := _first_unknown_key(operation, ["action", "node_path", "script_path"])
	if not unknown.is_empty():
		return _operation_error(index, "unsupported field: %s" % unknown)
	var node_path_value = operation.get("node_path")
	if not node_path_value is String:
		return _operation_error(index, "node_path must be a string")
	if not operation.has("script_path"):
		return _operation_error(index, "script_path is required")
	var node_result := _resolve_virtual_node(node_path_value, "node_path", context)
	if not bool(node_result.get("ok", false)):
		return _operation_error(index, str(node_result.error))
	var node := node_result.node as Node
	if not _is_directly_editable_node(node, context):
		return _operation_error(index, "node_path is inside a non-editable instanced subscene")
	var script_path = operation.get("script_path")
	var script: Script = null
	var canonical_path := ""
	if script_path != null:
		if not script_path is String:
			return _operation_error(index, "script_path must be a res:// .gd path or null")
		canonical_path = script_path
		var path_error := _resource_path_error(canonical_path)
		if not path_error.is_empty():
			return _operation_error(index, "invalid script_path: %s" % path_error)
		if not canonical_path.to_lower().ends_with(".gd"):
			return _operation_error(index, "script_path must point to a .gd script")
		if not ResourceLoader.exists(canonical_path):
			return _operation_error(index, "script_path does not exist: %s" % canonical_path)
		var loaded := ResourceLoader.load(canonical_path)
		if not loaded is Script:
			return _operation_error(index, "script_path could not be loaded as a Script: %s" % canonical_path)
		script = loaded as Script
		var base_type := str(script.get_instance_base_type())
		if base_type.is_empty():
			return _operation_error(index, "script_path has no instance base type: %s" % canonical_path)
		if not node.is_class(base_type):
			return _operation_error(index, "script base type %s is incompatible with node type %s" % [
				base_type,
				node.get_class(),
			])
	var state := _state_for_existing(node, context)
	var old_script = (
		state.property_values["script"]
		if state.property_values.has("script")
		else node.get_script()
	)
	context.do_steps.append(_property_step(node, &"script", script))
	context.undo_groups.append([_property_step(node, &"script", old_script)])
	state.property_values["script"] = script
	if script != null:
		context.resources.append(script)
	context.changes.append({
		"index": index,
		"action": "set_script",
		"node_path": _virtual_path(node, context),
		"script_path": null if canonical_path.is_empty() else canonical_path,
		"_node": node,
		"_before": old_script,
	})
	return {"ok": true}


func _validate_rename_node(operation: Dictionary, index: int, context: Dictionary) -> Dictionary:
	var unknown := _first_unknown_key(operation, ["action", "node_path", "new_name"])
	if not unknown.is_empty():
		return _operation_error(index, "unsupported field: %s" % unknown)
	var node_path_value = operation.get("node_path")
	var new_name_value = operation.get("new_name")
	if not node_path_value is String or not new_name_value is String:
		return _operation_error(index, "node_path and new_name must be strings")
	var name_error := _node_name_error(new_name_value)
	if not name_error.is_empty():
		return _operation_error(index, "invalid new_name: %s" % name_error)
	var node_result := _resolve_virtual_node(node_path_value, "node_path", context)
	if not bool(node_result.get("ok", false)):
		return _operation_error(index, str(node_result.error))
	var node := node_result.node as Node
	if not _is_directly_editable_node(node, context):
		return _operation_error(index, "node_path is inside a non-editable instanced subscene")
	var state := _state_for_existing(node, context)
	var old_name := str(state.name)
	if old_name == new_name_value:
		return _operation_error(index, "node already has the requested name")
	var parent := state.get("parent_node") as Node
	if parent != null:
		var collision := _find_virtual_child(parent, new_name_value, context, true)
		if collision != null and collision != node:
			return _operation_error(index, "a sibling named %s already exists" % new_name_value)
	var from_path := _virtual_path(node, context)
	context.do_steps.append(_property_step(node, &"name", StringName(new_name_value)))
	context.undo_groups.append([_property_step(node, &"name", StringName(old_name))])
	state.name = new_name_value
	context.changes.append({
		"index": index,
		"action": "rename_node",
		"node_path": from_path,
		"new_path": _virtual_path(node, context),
		"old_name": old_name,
		"new_name": new_name_value,
		"_node": node,
	})
	return {"ok": true}


func _validate_remove_node(operation: Dictionary, index: int, context: Dictionary) -> Dictionary:
	var unknown := _first_unknown_key(operation, ["action", "node_path"])
	if not unknown.is_empty():
		return _operation_error(index, "unsupported field: %s" % unknown)
	var node_path_value = operation.get("node_path")
	if not node_path_value is String:
		return _operation_error(index, "node_path must be a string")
	var node_result := _resolve_virtual_node(node_path_value, "node_path", context)
	if not bool(node_result.get("ok", false)):
		return _operation_error(index, str(node_result.error))
	var node := node_result.node as Node
	if not _is_directly_editable_node(node, context):
		return _operation_error(index, "node_path is inside a non-editable instanced subscene")
	if node == context.scene_root:
		return _operation_error(index, "the current scene root cannot be removed")
	for removed_node in context.removed_roots:
		if _virtual_is_ancestor(node, removed_node, context) or _virtual_is_ancestor(removed_node, node, context):
			return _operation_error(index, "overlapping subtree removals are not supported")
	var state := _state_for_existing(node, context)
	var parent := state.get("parent_node") as Node
	if parent == null:
		return _operation_error(index, "node has no parent inside the current scene")
	var siblings := _virtual_children(parent, context, false)
	var old_index := siblings.find(node)
	if old_index < 0:
		return _operation_error(index, "node is not an editable child of its parent")
	var owner_snapshot := _snapshot_virtual_owners(node, context)
	if not bool(owner_snapshot.get("ok", false)):
		return _operation_error(index, str(owner_snapshot.error))
	for owner_record in owner_snapshot.records:
		var removed_state := _state_for_existing(owner_record.node, context)
		if bool(removed_state.get("is_new", false)):
			return _operation_error(index, "a subtree containing nodes added in the same batch cannot be removed")
	var node_path := _virtual_path(node, context)
	context.do_steps.append(_method_step(parent, &"remove_child", [node]))
	var undo_group: Array = [
		_method_step(parent, &"add_child", [node, true]),
		_method_step(parent, &"move_child", [node, old_index]),
	]
	for owner_record in owner_snapshot.records:
		undo_group.append(_property_step(owner_record.node, &"owner", owner_record.owner))
	context.undo_groups.append(undo_group)
	context.undo_references.append(node)
	context.removed_roots.append(node)
	_virtual_remove_child(parent, node, context)
	state.removed = true
	context.changes.append({
		"index": index,
		"action": "remove_node",
		"node_path": node_path,
		"node_type": node.get_class(),
		"name": str(state.name),
		"subtree_node_count": owner_snapshot.records.size(),
		"_node": node,
	})
	return {"ok": true}


func _validate_duplicate_node(operation: Dictionary, index: int, context: Dictionary) -> Dictionary:
	var unknown := _first_unknown_key(operation, ["action", "node_path", "parent_path", "name"])
	if not unknown.is_empty():
		return _operation_error(index, "unsupported field: %s" % unknown)
	var node_path_value = operation.get("node_path")
	if not node_path_value is String:
		return _operation_error(index, "node_path must be a string")
	var source_result := _resolve_virtual_node(node_path_value, "node_path", context)
	if not bool(source_result.get("ok", false)):
		return _operation_error(index, str(source_result.error))
	var source := source_result.node as Node
	if not _is_directly_editable_node(source, context):
		return _operation_error(index, "node_path is inside a non-editable instanced subscene")
	if source == context.scene_root:
		return _operation_error(index, "the current scene root cannot be duplicated")
	if _subtree_has_virtual_changes(source, context):
		return _operation_error(index, "a node with earlier changes in this batch cannot be duplicated")
	var source_state := _state_for_existing(source, context)
	var parent := source_state.get("parent_node") as Node
	if operation.has("parent_path"):
		if not operation.parent_path is String:
			return _operation_error(index, "parent_path must be a string")
		var parent_result := _resolve_virtual_node(operation.parent_path, "parent_path", context)
		if not bool(parent_result.get("ok", false)):
			return _operation_error(index, str(parent_result.error))
		parent = parent_result.node
	if parent == null:
		return _operation_error(index, "parent_path is required when duplicating the scene root")
	if not _is_directly_editable_node(parent, context):
		return _operation_error(index, "parent_path is inside a non-editable instanced subscene")
	var requested_name := str(source_state.name)
	if operation.has("name"):
		if not operation.name is String:
			return _operation_error(index, "name must be a string")
		requested_name = operation.name
		var name_error := _node_name_error(requested_name)
		if not name_error.is_empty():
			return _operation_error(index, "invalid name: %s" % name_error)
	else:
		requested_name = _unique_virtual_name(parent, requested_name, context)
	if _find_virtual_child(parent, requested_name, context, true) != null:
		return _operation_error(index, "a child named %s already exists" % requested_name)

	var duplicate = source.duplicate()
	if not duplicate is Node:
		return _operation_error(index, "Godot could not duplicate node %s" % node_path_value)
	var copied: Node = duplicate
	copied.name = StringName(requested_name)
	var pairs_result := _pair_subtrees(source, copied)
	if not bool(pairs_result.get("ok", false)):
		copied.free()
		return _operation_error(index, str(pairs_result.error))
	context.new_nodes.append(copied)
	var source_to_copy: Dictionary = pairs_result.source_to_copy
	for pair in pairs_result.pairs:
		var original := pair.source as Node
		var clone := pair.copy as Node
		var clone_parent: Node = parent if clone == copied else clone.get_parent()
		var desired_owner: Node = null
		if clone == copied:
			desired_owner = context.scene_root
		elif original.owner != null:
			desired_owner = source_to_copy.get(original.owner.get_instance_id(), context.scene_root) as Node
		var original_state := _state_for_existing(original, context)
		var clone_state := _make_virtual_state(
			clone,
			clone_parent,
			true,
			desired_owner,
			bool(original_state.get("internal", false))
		)
		clone_state.editable = clone == copied or desired_owner == context.scene_root
		context.states[clone.get_instance_id()] = clone_state
	_virtual_append_child(parent, copied, context)
	context.do_steps.append(_method_step(parent, &"add_child", [copied, true]))
	for pair in pairs_result.pairs:
		var clone := pair.copy as Node
		var clone_state: Dictionary = context.states[clone.get_instance_id()]
		context.do_steps.append(_property_step(clone, &"owner", clone_state.owner))
	context.undo_groups.append([_method_step(parent, &"remove_child", [copied])])
	context.do_references.append(copied)
	context.changes.append({
		"index": index,
		"action": "duplicate_node",
		"source_path": node_path_value,
		"node_path": _virtual_path(copied, context),
		"node_type": copied.get_class(),
		"name": requested_name,
		"subtree_node_count": pairs_result.pairs.size(),
		"_node": copied,
	})
	return {"ok": true}


func _validate_reparent_node(operation: Dictionary, index: int, context: Dictionary) -> Dictionary:
	var unknown := _first_unknown_key(
		operation,
		["action", "node_path", "new_parent_path", "index", "new_name", "keep_global_transform"]
	)
	if not unknown.is_empty():
		return _operation_error(index, "unsupported field: %s" % unknown)
	var node_path_value = operation.get("node_path")
	var new_parent_path_value = operation.get("new_parent_path")
	if not node_path_value is String or not new_parent_path_value is String:
		return _operation_error(index, "node_path and new_parent_path must be strings")
	var node_result := _resolve_virtual_node(node_path_value, "node_path", context)
	if not bool(node_result.get("ok", false)):
		return _operation_error(index, str(node_result.error))
	var parent_result := _resolve_virtual_node(new_parent_path_value, "new_parent_path", context)
	if not bool(parent_result.get("ok", false)):
		return _operation_error(index, str(parent_result.error))
	var node := node_result.node as Node
	var new_parent := parent_result.node as Node
	if not _is_directly_editable_node(node, context):
		return _operation_error(index, "node_path is inside a non-editable instanced subscene")
	if not _is_directly_editable_node(new_parent, context):
		return _operation_error(index, "new_parent_path is inside a non-editable instanced subscene")
	if node == context.scene_root:
		return _operation_error(index, "the current scene root cannot be reparented")
	if node == new_parent or _virtual_is_ancestor(node, new_parent, context):
		return _operation_error(index, "new_parent_path cannot be the node or one of its descendants")
	var state := _state_for_existing(node, context)
	if bool(state.get("is_new", false)):
		return _operation_error(index, "nodes created in the same batch cannot be reparented")
	var old_parent := state.get("parent_node") as Node
	if old_parent == null:
		return _operation_error(index, "node has no parent inside the current scene")
	var old_name := str(state.name)
	var new_name := old_name
	if operation.has("new_name"):
		if not operation.new_name is String:
			return _operation_error(index, "new_name must be a string")
		new_name = operation.new_name
		var name_error := _node_name_error(new_name)
		if not name_error.is_empty():
			return _operation_error(index, "invalid new_name: %s" % name_error)
	var collision := _find_virtual_child(new_parent, new_name, context, true)
	if collision != null and collision != node:
		return _operation_error(index, "a child named %s already exists under new_parent_path" % new_name)
	var old_siblings := _virtual_children(old_parent, context, false)
	var old_index := old_siblings.find(node)
	if old_index < 0:
		return _operation_error(index, "node is not an editable child of its parent")
	var target_siblings := _virtual_children(new_parent, context, false)
	if old_parent == new_parent:
		target_siblings.erase(node)
	var target_index := target_siblings.size()
	if operation.has("index"):
		var integer_result := _json_integer(operation.index, "index")
		if not bool(integer_result.get("ok", false)):
			return _operation_error(index, str(integer_result.error))
		target_index = int(integer_result.value)
		if target_index < 0 or target_index > target_siblings.size():
			return _operation_error(index, "index is outside the new parent's child range")
	var keep_global := true
	if operation.has("keep_global_transform"):
		if not operation.keep_global_transform is bool:
			return _operation_error(index, "keep_global_transform must be a boolean")
		keep_global = operation.keep_global_transform
	if old_parent == new_parent and target_index == old_index and new_name == old_name:
		return _operation_error(index, "reparent_node would not change the scene")

	var owner_snapshot := _snapshot_virtual_owners(node, context)
	if not bool(owner_snapshot.get("ok", false)):
		return _operation_error(index, str(owner_snapshot.error))
	var from_path := _virtual_path(node, context)
	var do_group: Array = []
	var undo_group: Array = []
	if old_parent != new_parent:
		do_group.append(_method_step(node, &"reparent", [new_parent, keep_global]))
		undo_group.append(_method_step(node, &"reparent", [old_parent, keep_global]))
	if new_name != old_name:
		do_group.append(_property_step(node, &"name", StringName(new_name)))
		undo_group.append(_property_step(node, &"name", StringName(old_name)))
	for owner_record in owner_snapshot.records:
		var old_owner := owner_record.owner as Node
		if (
			old_owner != null
			and old_owner != context.scene_root
			and not _virtual_is_ancestor(node, old_owner, context)
		):
			return _operation_error(index, "reparent would cross an unsupported ownership domain")
		do_group.append(_property_step(owner_record.node, &"owner", old_owner))
		undo_group.append(_property_step(owner_record.node, &"owner", old_owner))
		var owner_state := _state_for_existing(owner_record.node, context)
		owner_state.owner = old_owner
	_virtual_remove_child(old_parent, node, context)
	state.parent_node = new_parent
	state.name = new_name
	_virtual_insert_child_at_external_index(new_parent, node, target_index, context)
	var structural_offset := 1 if old_parent != new_parent else 0
	do_group.insert(structural_offset, _method_step(new_parent, &"move_child", [node, target_index]))
	undo_group.insert(structural_offset, _method_step(old_parent, &"move_child", [node, old_index]))
	context.do_steps.append_array(do_group)
	context.undo_groups.append(undo_group)
	context.changes.append({
		"index": index,
		"action": "reparent_node",
		"node_path": from_path,
		"old_parent_path": _virtual_path(old_parent, context),
		"new_parent_path": new_parent_path_value,
		"old_index": old_index,
		"new_index": target_index,
		"old_name": old_name,
		"new_name": new_name,
		"new_path": _virtual_path(node, context),
		"keep_global_transform": keep_global,
		"_node": node,
	})
	return {"ok": true}


func _validate_instantiate_scene(operation: Dictionary, index: int, context: Dictionary) -> Dictionary:
	var unknown := _first_unknown_key(
		operation,
		["action", "parent_path", "scene_path", "name", "properties"]
	)
	if not unknown.is_empty():
		return _operation_error(index, "unsupported field: %s" % unknown)
	var parent_path_value = operation.get("parent_path")
	var scene_path_value = operation.get("scene_path")
	if not parent_path_value is String or not scene_path_value is String:
		return _operation_error(index, "parent_path and scene_path must be strings")
	var parent_result := _resolve_virtual_node(parent_path_value, "parent_path", context)
	if not bool(parent_result.get("ok", false)):
		return _operation_error(index, str(parent_result.error))
	var parent := parent_result.node as Node
	if not _is_directly_editable_node(parent, context):
		return _operation_error(index, "parent_path is inside a non-editable instanced subscene")
	var resource_result := _load_resource_reference({
		"godot_type": RESOURCE_TAG,
		"path": scene_path_value,
		"expected_type": "PackedScene",
	}, "scene_path", "PackedScene")
	if not bool(resource_result.get("ok", false)):
		return _operation_error(index, str(resource_result.error))
	var packed_scene := resource_result.value as PackedScene
	if packed_scene == null:
		return _operation_error(index, "scene_path did not load a PackedScene")
	if not context.scene_root.scene_file_path.is_empty() and resource_result.path == context.scene_root.scene_file_path:
		return _operation_error(index, "the current scene cannot instantiate itself")
	var edit_state := (
		PackedScene.GEN_EDIT_STATE_INSTANCE
		if Engine.is_editor_hint()
		else PackedScene.GEN_EDIT_STATE_DISABLED
	)
	var instance = packed_scene.instantiate(edit_state)
	if not instance is Node:
		return _operation_error(index, "Godot could not instantiate scene_path")
	var node: Node = instance
	var requested_name := str(node.name)
	if operation.has("name"):
		if not operation.name is String:
			node.free()
			return _operation_error(index, "name must be a string")
		requested_name = operation.name
		var name_error := _node_name_error(requested_name)
		if not name_error.is_empty():
			node.free()
			return _operation_error(index, "invalid name: %s" % name_error)
	else:
		requested_name = _unique_virtual_name(parent, requested_name, context)
	if _find_virtual_child(parent, requested_name, context, true) != null:
		node.free()
		return _operation_error(index, "a child named %s already exists" % requested_name)
	node.name = StringName(requested_name)
	var subtree_result := _register_new_subtree(node, parent, context)
	if not bool(subtree_result.get("ok", false)):
		node.free()
		return _operation_error(index, str(subtree_result.error))
	context.new_nodes.append(node)
	_virtual_append_child(parent, node, context)

	var properties_value = operation.get("properties", {})
	if not properties_value is Dictionary:
		return _operation_error(index, "properties must be an object")
	var properties: Dictionary = properties_value
	if properties.size() > MAX_ADD_PROPERTIES:
		return _operation_error(index, "properties exceeds the %d item limit" % MAX_ADD_PROPERTIES)
	var property_names: Array = properties.keys()
	for property_key in property_names:
		if not property_key is String:
			return _operation_error(index, "property names must be strings")
	property_names.sort()
	var prepared_properties: Array = []
	for property_name_value in property_names:
		var prepared := _prepare_property_value(
			node,
			property_name_value,
			properties[property_name_value],
			"properties.%s" % property_name_value,
			context
		)
		if not bool(prepared.get("ok", false)):
			return _operation_error(index, str(prepared.error))
		prepared_properties.append({"name": property_name_value, "value": prepared.value})
		var state: Dictionary = context.states[node.get_instance_id()]
		state.property_values[property_name_value] = prepared.value
	context.do_steps.append(_method_step(parent, &"add_child", [node, true]))
	context.do_steps.append(_property_step(node, &"owner", context.scene_root))
	for prepared in prepared_properties:
		context.do_steps.append(_property_step(node, StringName(prepared.name), prepared.value))
	context.undo_groups.append([_method_step(parent, &"remove_child", [node])])
	context.do_references.append(node)
	context.resources.append(packed_scene)
	context.changes.append({
		"index": index,
		"action": "instantiate_scene",
		"scene_path": resource_result.path,
		"parent_path": parent_path_value,
		"node_path": _virtual_path(node, context),
		"node_type": node.get_class(),
		"name": requested_name,
		"properties": property_names,
		"subtree_node_count": int(subtree_result.count),
		"_node": node,
	})
	return {"ok": true}


func _prepare_property_value(
	node: Node,
	property: String,
	raw_value: Variant,
	label: String,
	context: Dictionary = {}
) -> Dictionary:
	var property_error := _property_name_error(property)
	if not property_error.is_empty():
		return _error("invalid property %s: %s" % [property, property_error])
	var property_root := property.get_slice("/", 0)
	if BLOCKED_PROPERTIES.has(property_root):
		if property_root == "script":
			return _error("property script must use action set_script with script_path")
		return _error("property must use its dedicated structural operation: %s" % property)
	var info_result := _find_property_info(node, property)
	if not bool(info_result.get("ok", false)):
		return info_result
	var info: Dictionary = info_result.info
	var usage := int(info.get("usage", 0))
	var structural := PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP
	if (
		(usage & structural) != 0
		or (usage & PROPERTY_USAGE_INTERNAL) != 0
		or (usage & PROPERTY_USAGE_READ_ONLY) != 0
	):
		return _error("property is internal or read-only: %s" % property)
	if (usage & (PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_STORAGE)) == 0:
		return _error("property is not editor- or storage-visible: %s" % property)
	var type_id := int(info.get("type", TYPE_NIL))
	if type_id == TYPE_ARRAY and _property_is_typed_array(node, property, info):
		return _error("typed Array properties are not supported yet: %s" % property)
	if type_id == TYPE_OBJECT:
		var script_resource_error := _script_resource_property_error(info)
		if raw_value != null and not script_resource_error.is_empty():
			return _error("script Resource types are not supported yet: %s" % script_resource_error)
	var decoded := _decode_json_value(raw_value, true, label)
	if not bool(decoded.get("ok", false)):
		return decoded
	if type_id == TYPE_NODE_PATH:
		if not decoded.value is NodePath:
			return _error("property %s requires a NodePath tag" % property)
		return _defer_node_path_property(node, property, decoded.value, info, context)
	var coerced := _coerce_property_value(
		decoded.value,
		type_id,
		property,
		info,
		node,
		context
	)
	if not bool(coerced.get("ok", false)):
		return coerced
	return _validate_property_hint(
		coerced.value,
		info,
		node,
		property,
		context,
		coerced.get("target")
	)


func _find_property_info(node: Node, property: String) -> Dictionary:
	var scanned := 0
	for raw_info in node.get_property_list():
		if scanned >= MAX_PROPERTY_SCAN:
			return _error("property list exceeds the %d item scan limit" % MAX_PROPERTY_SCAN)
		scanned += 1
		if raw_info is Dictionary and str(raw_info.get("name", "")) == property:
			return {"ok": true, "info": raw_info}
	return _error("node %s has no property named %s" % [node.get_class(), property])


func _defer_node_path_property(
	node: Node,
	property: String,
	root_relative_path: NodePath,
	info: Dictionary,
	context: Dictionary
) -> Dictionary:
	if context.is_empty() or not context.has("scene_root"):
		return _error("property %s NodePath requires current-scene context" % property)
	var target: Node = null
	if not root_relative_path.is_empty():
		var target_result := _resolve_virtual_node(str(root_relative_path), "NodePath target", context)
		if not bool(target_result.get("ok", false)):
			return _error("property %s has an unresolved NodePath target: %s" % [property, str(root_relative_path)])
		target = target_result.node
	var hint_result := _validate_property_hint(
		root_relative_path,
		info,
		node,
		property,
		context,
		target
	)
	if not bool(hint_result.get("ok", false)):
		return hint_result
	var marker := {
		"__godetx_deferred_node_path": true,
		"source": node,
		"target": target,
		"empty": root_relative_path.is_empty(),
		"operation_index": int(context.get("operation_index", -1)),
		"property": property,
		"resolved_value": NodePath(""),
	}
	context.pending_node_paths.append(marker)
	return {"ok": true, "value": marker}


func _resolve_pending_node_paths(context: Dictionary) -> Dictionary:
	for marker_value in context.pending_node_paths:
		var marker: Dictionary = marker_value
		var source := marker.source as Node
		var source_state := _state_for_existing(source, context)
		if bool(source_state.removed) or _virtual_path(source, context).is_empty():
			return _operation_error(
				int(marker.operation_index),
				"NodePath property source was removed from the final virtual scene: %s" % marker.property
			)
		if bool(marker.empty):
			marker.resolved_value = NodePath("")
			continue
		var target := marker.target as Node
		var target_state := _state_for_existing(target, context)
		if bool(target_state.removed) or _virtual_path(target, context).is_empty():
			return _operation_error(
				int(marker.operation_index),
				"NodePath target was removed from the final virtual scene: %s" % marker.property
			)
		var relative_result := _relative_virtual_path(source, target, context)
		if not bool(relative_result.get("ok", false)):
			return _operation_error(int(marker.operation_index), str(relative_result.error))
		marker.resolved_value = NodePath(relative_result.path)
	_resolve_planned_step_values(context.do_steps)
	for group in context.undo_groups:
		_resolve_planned_step_values(group)
	for state_value in context.states.values():
		var state: Dictionary = state_value
		for property_name in state.property_values.keys():
			state.property_values[property_name] = _resolved_planned_value(state.property_values[property_name])
	return {"ok": true}


func _resolve_planned_step_values(steps: Array) -> void:
	for step_value in steps:
		var step: Dictionary = step_value
		if str(step.get("kind", "")) == "property":
			step.value = _resolved_planned_value(step.value)


func _resolved_planned_value(value: Variant) -> Variant:
	if value is Dictionary and bool(value.get("__godetx_deferred_node_path", false)):
		return value.get("resolved_value", NodePath(""))
	return value


func _property_is_typed_array(node: Node, property: String, info: Dictionary) -> bool:
	var hint := int(info.get("hint", PROPERTY_HINT_NONE))
	var hint_string := str(info.get("hint_string", ""))
	if hint == PROPERTY_HINT_ARRAY_TYPE:
		return true
	if hint == PROPERTY_HINT_TYPE_STRING and not hint_string.is_empty():
		return true
	var declared_class := str(info.get("class_name", ""))
	if declared_class.begins_with("Array["):
		return true
	var current = node.get(StringName(property))
	if current is Array:
		var current_array: Array = current
		return current_array.is_typed()
	return false


func _script_resource_property_error(info: Dictionary) -> String:
	var declared_class := str(info.get("class_name", "")).strip_edges()
	var resource_hint := int(info.get("hint", PROPERTY_HINT_NONE)) == PROPERTY_HINT_RESOURCE_TYPE
	if (
		resource_hint
		and not declared_class.is_empty()
		and declared_class != "Object"
		and not _is_native_resource_class(declared_class)
	):
		return declared_class
	if resource_hint:
		for hinted_type in str(info.get("hint_string", "")).split(",", false):
			var normalized := hinted_type.strip_edges()
			if not normalized.is_empty() and not _is_native_resource_class(normalized):
				return normalized
	return ""


func _decode_json_value(value: Variant, allow_array: bool, label: String) -> Dictionary:
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT:
			return {"ok": true, "value": value}
		TYPE_FLOAT:
			var number := float(value)
			if is_nan(number) or is_inf(number):
				return _error("%s must be finite" % label)
			return {"ok": true, "value": number}
		TYPE_STRING:
			if value.length() > MAX_STRING_LENGTH:
				return _error("%s exceeds the %d character limit" % [label, MAX_STRING_LENGTH])
			return {"ok": true, "value": value}
		TYPE_ARRAY:
			if not allow_array:
				return _error("nested arrays are not supported: %s" % label)
			if value.size() > MAX_ARRAY_ITEMS:
				return _error("%s exceeds the %d item array limit" % [label, MAX_ARRAY_ITEMS])
			var decoded_items: Array = []
			for item_index in range(value.size()):
				var raw_item = value[item_index]
				if (
					raw_item is Dictionary
					and str(raw_item.get("godot_type", "")) in [RESOURCE_TAG, NODE_PATH_TAG]
				):
					return _error("Resource and NodePath tags are only supported as scalar properties: %s[%d]" % [label, item_index])
				var decoded := _decode_json_value(value[item_index], false, "%s[%d]" % [label, item_index])
				if not bool(decoded.get("ok", false)):
					return decoded
				decoded_items.append(decoded.value)
			return {"ok": true, "value": decoded_items}
		TYPE_DICTIONARY:
			return _decode_tagged_value(value, label)
		_:
			return _error("%s must be JSON-safe tagged data" % label)


func _decode_tagged_value(value: Dictionary, label: String) -> Dictionary:
	var tag_value = value.get("godot_type")
	if not tag_value is String:
		return _error("%s object requires godot_type" % label)
	match tag_value:
		"int64":
			if not _has_exact_keys(value, ["godot_type", "value"]) or not value.value is String:
				return _error("%s int64 tag requires only a decimal string value" % label)
			return _decode_int64(value.value, label)
		"Vector2":
			return _decode_float_vector(value, tag_value, ["x", "y"], label)
		"Vector2i":
			return _decode_int_vector(value, tag_value, ["x", "y"], label)
		"Vector3":
			return _decode_float_vector(value, tag_value, ["x", "y", "z"], label)
		"Vector3i":
			return _decode_int_vector(value, tag_value, ["x", "y", "z"], label)
		"Vector4":
			return _decode_float_vector(value, tag_value, ["x", "y", "z", "w"], label)
		"Vector4i":
			return _decode_int_vector(value, tag_value, ["x", "y", "z", "w"], label)
		"Color":
			if not _has_exact_keys(value, ["godot_type", "r", "g", "b", "a"]):
				return _error("%s Color tag has unexpected or missing fields" % label)
			var components := _finite_components(value, ["r", "g", "b", "a"], label)
			if not bool(components.get("ok", false)):
				return components
			return {
				"ok": true,
				"value": Color(components.values[0], components.values[1], components.values[2], components.values[3]),
			}
		RESOURCE_TAG:
			return _load_resource_reference(value, label)
		NODE_PATH_TAG:
			if not _has_exact_keys(value, ["godot_type", "path"]) or not value.path is String:
				return _error("%s NodePath tag requires only a string path" % label)
			var path_error := _node_path_value_error(value.path)
			if not path_error.is_empty():
				return _error("invalid NodePath for %s: %s" % [label, path_error])
			return {"ok": true, "value": NodePath(value.path)}
		_:
			return _error("unsupported godot_type for %s: %s" % [label, tag_value])


func _decode_float_vector(value: Dictionary, tag: String, fields: Array, label: String) -> Dictionary:
	var keys: Array = ["godot_type"]
	keys.append_array(fields)
	if not _has_exact_keys(value, keys):
		return _error("%s %s tag has unexpected or missing fields" % [label, tag])
	var components := _finite_components(value, fields, label)
	if not bool(components.get("ok", false)):
		return components
	match tag:
		"Vector2":
			return {"ok": true, "value": Vector2(components.values[0], components.values[1])}
		"Vector3":
			return {"ok": true, "value": Vector3(components.values[0], components.values[1], components.values[2])}
		"Vector4":
			return {
				"ok": true,
				"value": Vector4(components.values[0], components.values[1], components.values[2], components.values[3]),
			}
	return _error("unsupported vector tag: %s" % tag)


func _decode_int_vector(value: Dictionary, tag: String, fields: Array, label: String) -> Dictionary:
	var keys: Array = ["godot_type"]
	keys.append_array(fields)
	if not _has_exact_keys(value, keys):
		return _error("%s %s tag has unexpected or missing fields" % [label, tag])
	var components: Array[int] = []
	for field in fields:
		var component = value.get(field)
		var integer_result := _json_integer(component, "%s.%s" % [label, field])
		if not bool(integer_result.get("ok", false)):
			return integer_result
		var integer := int(integer_result.value)
		if integer < -2147483648 or integer > 2147483647:
			return _error("%s.%s must be a signed 32-bit integer" % [label, field])
		components.append(integer)
	match tag:
		"Vector2i":
			return {"ok": true, "value": Vector2i(components[0], components[1])}
		"Vector3i":
			return {"ok": true, "value": Vector3i(components[0], components[1], components[2])}
		"Vector4i":
			return {"ok": true, "value": Vector4i(components[0], components[1], components[2], components[3])}
	return _error("unsupported integer vector tag: %s" % tag)


func _finite_components(value: Dictionary, fields: Array, label: String) -> Dictionary:
	var components: Array[float] = []
	for field in fields:
		var component = value.get(field)
		if not (component is int or component is float):
			return _error("%s.%s must be a number" % [label, field])
		var number := float(component)
		if is_nan(number) or is_inf(number):
			return _error("%s.%s must be finite" % [label, field])
		components.append(number)
	return {"ok": true, "values": components}


func _decode_int64(value: String, label: String) -> Dictionary:
	if value.is_empty() or value.length() > 20:
		return _error("%s int64 value is invalid" % label)
	var negative := value.begins_with("-")
	var digits := value.trim_prefix("-")
	if digits.is_empty():
		return _error("%s int64 value is invalid" % label)
	for index in range(digits.length()):
		var code := digits.unicode_at(index)
		if code < 48 or code > 57:
			return _error("%s int64 value is invalid" % label)
	var normalized := digits.trim_prefix("0")
	while normalized.begins_with("0"):
		normalized = normalized.trim_prefix("0")
	if normalized.is_empty():
		normalized = "0"
	var maximum := "9223372036854775808" if negative else "9223372036854775807"
	if normalized.length() > maximum.length() or (normalized.length() == maximum.length() and normalized > maximum):
		return _error("%s int64 value is out of range" % label)
	var canonical := ("-" if negative and normalized != "0" else "") + normalized
	return {"ok": true, "value": canonical.to_int()}


func _json_integer(value: Variant, label: String) -> Dictionary:
	if value is int:
		return {"ok": true, "value": value}
	if not value is float:
		return _error("%s must be an integer" % label)
	var number := float(value)
	if is_nan(number) or is_inf(number) or number != floor(number):
		return _error("%s must be an integer" % label)
	if number < -float(JSON_SAFE_INTEGER_MAX) or number > float(JSON_SAFE_INTEGER_MAX):
		return _error("%s exceeds the exact JSON integer range" % label)
	return {"ok": true, "value": int(number)}


func _coerce_property_value(
	value: Variant,
	type_id: int,
	property: String,
	info: Dictionary = {},
	node: Node = null,
	context: Dictionary = {}
) -> Dictionary:
	match type_id:
		TYPE_NIL:
			return {"ok": true, "value": value}
		TYPE_BOOL:
			if value is bool:
				return {"ok": true, "value": value}
		TYPE_INT:
			return _json_integer(value, "property %s" % property)
		TYPE_FLOAT:
			if value is int or value is float:
				return {"ok": true, "value": float(value)}
		TYPE_STRING:
			if value is String:
				return {"ok": true, "value": value}
		TYPE_STRING_NAME:
			if value is String:
				return {"ok": true, "value": StringName(value)}
		TYPE_NODE_PATH:
			if value is NodePath:
				var target_result := _validate_node_path_target(node, value, context, property)
				if bool(target_result.get("ok", false)):
					return {
						"ok": true,
						"value": target_result.value,
						"target": target_result.get("target"),
					}
				return target_result
		TYPE_VECTOR2:
			if value is Vector2:
				return {"ok": true, "value": value}
		TYPE_VECTOR2I:
			if value is Vector2i:
				return {"ok": true, "value": value}
		TYPE_VECTOR3:
			if value is Vector3:
				return {"ok": true, "value": value}
		TYPE_VECTOR3I:
			if value is Vector3i:
				return {"ok": true, "value": value}
		TYPE_VECTOR4:
			if value is Vector4:
				return {"ok": true, "value": value}
		TYPE_VECTOR4I:
			if value is Vector4i:
				return {"ok": true, "value": value}
		TYPE_COLOR:
			if value is Color:
				return {"ok": true, "value": value}
		TYPE_OBJECT:
			if value == null:
				return {"ok": true, "value": null}
			if value is Resource:
				var class_result := _validate_resource_class(value, _property_resource_types(info), property)
				if bool(class_result.get("ok", false)):
					return {"ok": true, "value": value}
				return class_result
		TYPE_ARRAY:
			if value is Array:
				return {"ok": true, "value": value}
		TYPE_PACKED_BYTE_ARRAY:
			return _coerce_packed_array(value, type_id, property)
		TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY:
			return _coerce_packed_array(value, type_id, property)
		TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY:
			return _coerce_packed_array(value, type_id, property)
		TYPE_PACKED_STRING_ARRAY, TYPE_PACKED_VECTOR2_ARRAY, TYPE_PACKED_VECTOR3_ARRAY:
			return _coerce_packed_array(value, type_id, property)
		TYPE_PACKED_COLOR_ARRAY, TYPE_PACKED_VECTOR4_ARRAY:
			return _coerce_packed_array(value, type_id, property)
	return _error(
		"value type %s is incompatible with property %s (%s)" % [
			type_string(typeof(value)),
			property,
			type_string(type_id) if type_id >= TYPE_NIL and type_id < TYPE_MAX else "Unknown",
		]
	)


func _validate_property_hint(
	value: Variant,
	info: Dictionary,
	node: Node,
	property: String,
	context: Dictionary = {},
	resolved_node_path_target: Node = null
) -> Dictionary:
	var hint := int(info.get("hint", PROPERTY_HINT_NONE))
	var hint_string := str(info.get("hint_string", ""))
	if value is int and hint in [PROPERTY_HINT_ENUM, PROPERTY_HINT_ENUM_SUGGESTION]:
		var allowed_values := _enum_hint_values(hint_string)
		if not allowed_values.is_empty() and not allowed_values.has(int(value)):
			return _error("property %s enum does not define value %d" % [property, int(value)])
	if value is int and hint == PROPERTY_HINT_FLAGS:
		var allowed_mask := _flags_hint_mask(hint_string)
		if int(value) < 0 or (int(value) & ~allowed_mask) != 0:
			return _error("property %s contains undefined flag bits" % property)
	if (value is int or value is float) and hint == PROPERTY_HINT_RANGE:
		var range_result := _validate_range_hint(float(value), hint_string, property)
		if not bool(range_result.get("ok", false)):
			return range_result
	if value is NodePath and not value.is_empty() and hint == PROPERTY_HINT_NODE_PATH_VALID_TYPES:
		var expected_types := hint_string.split(",", false)
		if not expected_types.is_empty():
			var target := resolved_node_path_target
			if target == null:
				return _error("property %s has an unresolved NodePath target" % property)
			var accepted := false
			for expected_type in expected_types:
				var normalized := expected_type.strip_edges()
				if not normalized.is_empty() and target.is_class(normalized):
					accepted = true
					break
			if not accepted:
				return _error("property %s NodePath target has incompatible type %s" % [property, target.get_class()])
	return {"ok": true, "value": value}


func _load_resource_reference(
	tag: Dictionary,
	label: String,
	required_type: String = ""
) -> Dictionary:
	var unknown := _first_unknown_key(tag, ["godot_type", "path", "expected_type", "uid"])
	if not unknown.is_empty() or str(tag.get("godot_type", "")) != RESOURCE_TAG:
		return _error("%s Resource tag has unexpected fields" % label)
	if not tag.has("path") and not tag.has("uid"):
		return _error("%s Resource tag requires path or uid" % label)
	var canonical_path := ""
	if tag.has("path"):
		if not tag.path is String:
			return _error("%s Resource path must be a string" % label)
		var path_error := _resource_path_error(tag.path)
		if not path_error.is_empty():
			return _error("invalid resource path for %s: %s" % [label, path_error])
		canonical_path = tag.path
	var explicit_type := required_type
	if tag.has("expected_type"):
		if not tag.expected_type is String or not _is_ascii_identifier(tag.expected_type):
			return _error("%s expected_type must be a built-in class identifier" % label)
		if not _is_native_resource_class(tag.expected_type):
			return _error("%s script Resource expected_type is not supported yet" % label)
		if not required_type.is_empty() and not _class_is_or_inherits(tag.expected_type, required_type):
			return _error("%s expected_type conflicts with required type %s" % [label, required_type])
		explicit_type = tag.expected_type
	if not required_type.is_empty() and not _is_native_resource_class(required_type):
		return _error("invalid required resource type: %s" % required_type)
	if tag.has("uid"):
		if not tag.uid is String or not tag.uid.begins_with("uid://"):
			return _error("%s uid must be a uid:// string" % label)
		var uid_id := ResourceUID.text_to_id(tag.uid)
		if uid_id < 0 or not ResourceUID.has_id(uid_id):
			return _error("%s uid is not registered in this project" % label)
		var uid_path := ResourceUID.get_id_path(uid_id)
		var uid_path_error := _resource_path_error(uid_path)
		if not uid_path_error.is_empty():
			return _error("%s uid resolves outside res://" % label)
		if not canonical_path.is_empty() and uid_path != canonical_path:
			return _error("%s uid does not resolve to path" % label)
		canonical_path = uid_path
	if not ResourceLoader.exists(canonical_path, explicit_type):
		return _error("resource does not exist or has incompatible type: %s" % canonical_path)
	var loaded := ResourceLoader.load(canonical_path, explicit_type)
	if not loaded is Resource:
		return _error("resource could not be loaded: %s" % canonical_path)
	if not explicit_type.is_empty() and not loaded.is_class(explicit_type):
		return _error("resource %s is not a %s" % [canonical_path, explicit_type])
	return {"ok": true, "value": loaded, "path": canonical_path}


func _validate_resource_class(resource: Resource, expected_types: PackedStringArray, property: String) -> Dictionary:
	if expected_types.is_empty():
		return _error("property %s does not declare an assignable Resource type" % property)
	for expected_type in expected_types:
		if resource.is_class(expected_type):
			return {"ok": true}
	return _error(
		"resource type %s is incompatible with property %s (%s)" % [
			resource.get_class(),
			property,
			", ".join(expected_types),
		]
	)


func _property_resource_types(info: Dictionary) -> PackedStringArray:
	var result := PackedStringArray()
	var class_name_value := str(info.get("class_name", "")).strip_edges()
	if not class_name_value.is_empty() and _is_native_resource_class(class_name_value):
		result.append(class_name_value)
	if int(info.get("hint", PROPERTY_HINT_NONE)) == PROPERTY_HINT_RESOURCE_TYPE:
		for raw_type in str(info.get("hint_string", "")).split(",", false):
			var type_name := raw_type.strip_edges()
			if not type_name.is_empty() and _is_native_resource_class(type_name) and not result.has(type_name):
				result.append(type_name)
	return result


func _validate_node_path_target(
	node: Node,
	value: NodePath,
	context: Dictionary,
	property: String
) -> Dictionary:
	if value.is_empty():
		return {"ok": true, "target": null, "value": value}
	if node == null or context.is_empty() or not context.has("scene_root"):
		return _error("property %s NodePath requires current-scene context" % property)
	var target_result := _resolve_virtual_node(str(value), "NodePath target", context)
	if not bool(target_result.get("ok", false)):
		return _error("property %s has an unresolved NodePath target: %s" % [property, str(value)])
	var target := target_result.node as Node
	var relative_path: NodePath
	if node.is_inside_tree() and target.is_inside_tree():
		relative_path = node.get_path_to(target)
	else:
		var relative_result := _relative_virtual_path(node, target, context)
		if not bool(relative_result.get("ok", false)):
			return _error("property %s cannot express its NodePath target" % property)
		relative_path = NodePath(relative_result.path)
	return {"ok": true, "target": target, "value": relative_path}


func _enum_hint_values(hint_string: String) -> Array[int]:
	var values: Array[int] = []
	var next_value := 0
	for entry in hint_string.split(",", false):
		var pieces := entry.rsplit(":", true, 1)
		if pieces.size() == 2 and pieces[1].strip_edges().is_valid_int():
			next_value = pieces[1].strip_edges().to_int()
		values.append(next_value)
		next_value += 1
	return values


func _flags_hint_mask(hint_string: String) -> int:
	var mask := 0
	var bit := 1
	for entry in hint_string.split(",", false):
		var pieces := entry.rsplit(":", true, 1)
		var value := bit
		if pieces.size() == 2 and pieces[1].strip_edges().is_valid_int():
			value = pieces[1].strip_edges().to_int()
		if value >= 0:
			mask |= value
		bit <<= 1
	return mask


func _validate_range_hint(value: float, hint_string: String, property: String) -> Dictionary:
	var parts := hint_string.split(",", false)
	if parts.size() < 2:
		return {"ok": true}
	var minimum_text := parts[0].strip_edges()
	var maximum_text := parts[1].strip_edges()
	if not minimum_text.is_valid_float() or not maximum_text.is_valid_float():
		return {"ok": true}
	var minimum := minimum_text.to_float()
	var maximum := maximum_text.to_float()
	var normalized_parts := PackedStringArray()
	for part in parts:
		normalized_parts.append(part.strip_edges())
	var allow_less := normalized_parts.has("or_less")
	var allow_greater := normalized_parts.has("or_greater")
	if value < minimum and not allow_less:
		return _error("property %s is below its minimum %s" % [property, minimum])
	if value > maximum and not allow_greater:
		return _error("property %s is above its maximum %s" % [property, maximum])
	return {"ok": true}


func _coerce_packed_array(value: Variant, type_id: int, property: String) -> Dictionary:
	if not value is Array:
		return _error("property %s requires a one-dimensional array" % property)
	var normalized: Array = []
	for item_index in range(value.size()):
		var item = value[item_index]
		match type_id:
			TYPE_PACKED_BYTE_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY:
				var integer_result := _json_integer(item, "property %s[%d]" % [property, item_index])
				if not bool(integer_result.get("ok", false)):
					return integer_result
				var integer := int(integer_result.value)
				if type_id == TYPE_PACKED_BYTE_ARRAY and (integer < 0 or integer > 255):
					return _error("property %s[%d] must be an unsigned 8-bit integer" % [property, item_index])
				if type_id == TYPE_PACKED_INT32_ARRAY and (integer < -2147483648 or integer > 2147483647):
					return _error("property %s[%d] must be a signed 32-bit integer" % [property, item_index])
				normalized.append(integer)
			TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY:
				if not (item is int or item is float):
					return _error("property %s contains an incompatible packed-array item" % property)
				var number := float(item)
				if is_nan(number) or is_inf(number):
					return _error("property %s[%d] must be finite" % [property, item_index])
				normalized.append(number)
			TYPE_PACKED_STRING_ARRAY:
				if not item is String:
					return _error("property %s contains an incompatible packed-array item" % property)
				normalized.append(item)
			TYPE_PACKED_VECTOR2_ARRAY:
				if not item is Vector2:
					return _error("property %s contains an incompatible packed-array item" % property)
				normalized.append(item)
			TYPE_PACKED_VECTOR3_ARRAY:
				if not item is Vector3:
					return _error("property %s contains an incompatible packed-array item" % property)
				normalized.append(item)
			TYPE_PACKED_COLOR_ARRAY:
				if not item is Color:
					return _error("property %s contains an incompatible packed-array item" % property)
				normalized.append(item)
			TYPE_PACKED_VECTOR4_ARRAY:
				if not item is Vector4:
					return _error("property %s contains an incompatible packed-array item" % property)
				normalized.append(item)
	match type_id:
		TYPE_PACKED_BYTE_ARRAY:
			return {"ok": true, "value": PackedByteArray(normalized)}
		TYPE_PACKED_INT32_ARRAY:
			return {"ok": true, "value": PackedInt32Array(normalized)}
		TYPE_PACKED_INT64_ARRAY:
			return {"ok": true, "value": PackedInt64Array(normalized)}
		TYPE_PACKED_FLOAT32_ARRAY:
			return {"ok": true, "value": PackedFloat32Array(normalized)}
		TYPE_PACKED_FLOAT64_ARRAY:
			return {"ok": true, "value": PackedFloat64Array(normalized)}
		TYPE_PACKED_STRING_ARRAY:
			return {"ok": true, "value": PackedStringArray(normalized)}
		TYPE_PACKED_VECTOR2_ARRAY:
			return {"ok": true, "value": PackedVector2Array(normalized)}
		TYPE_PACKED_VECTOR3_ARRAY:
			return {"ok": true, "value": PackedVector3Array(normalized)}
		TYPE_PACKED_COLOR_ARRAY:
			return {"ok": true, "value": PackedColorArray(normalized)}
		TYPE_PACKED_VECTOR4_ARRAY:
			return {"ok": true, "value": PackedVector4Array(normalized)}
	return _error("unsupported packed-array property: %s" % property)


func _make_virtual_state(
	node: Node,
	parent: Node,
	is_new: bool,
	owner: Node,
	internal: bool = false
) -> Dictionary:
	return {
		"node": node,
		"parent_node": parent,
		"name": str(node.name),
		"removed": false,
		"is_new": is_new,
		"owner": owner,
		"property_values": {},
		"internal": internal,
		"editable": true,
	}


func _register_new_subtree(node: Node, parent: Node, context: Dictionary) -> Dictionary:
	var pending: Array = [node]
	var count := 0
	while not pending.is_empty():
		if count >= MAX_DUPLICATE_NODES:
			return _error("instantiated subtree exceeds the %d node limit" % MAX_DUPLICATE_NODES)
		var current := pending.pop_back() as Node
		var virtual_parent: Node = parent if current == node else current.get_parent()
		var desired_owner: Node = context.scene_root if current == node else current.owner
		var internal := _physical_child_is_internal(current, virtual_parent)
		var state := _make_virtual_state(
			current,
			virtual_parent,
			true,
			desired_owner,
			internal
		)
		state["editable"] = current == node
		context.states[current.get_instance_id()] = state
		count += 1
		var children := current.get_children(true)
		for child_index in range(children.size() - 1, -1, -1):
			if children[child_index] is Node:
				pending.append(children[child_index])
	return {"ok": true, "count": count}


func _pair_subtrees(source: Node, copy: Node) -> Dictionary:
	var pending: Array = [{"source": source, "copy": copy}]
	var pairs: Array = []
	var source_to_copy: Dictionary = {}
	while not pending.is_empty():
		if pairs.size() >= MAX_DUPLICATE_NODES:
			return _error("duplicated subtree exceeds the %d node limit" % MAX_DUPLICATE_NODES)
		var pair: Dictionary = pending.pop_back()
		var original := pair.source as Node
		var clone := pair.copy as Node
		if original.get_class() != clone.get_class():
			return _error("duplicated subtree changed a node class")
		if original != source and original.name != clone.name:
			return _error("duplicated subtree changed a child name or order")
		if original.get_script() != clone.get_script():
			return _error("duplicated subtree did not preserve a script reference")
		pairs.append(pair)
		source_to_copy[original.get_instance_id()] = clone
		var source_children := original.get_children(true)
		var copied_children := clone.get_children(true)
		if source_children.size() != copied_children.size():
			return _error("duplicated subtree structure does not match its source")
		for child_index in range(source_children.size() - 1, -1, -1):
			if not source_children[child_index] is Node or not copied_children[child_index] is Node:
				return _error("duplicated subtree contains an unsupported child")
			pending.append({
				"source": source_children[child_index],
				"copy": copied_children[child_index],
			})
	return {"ok": true, "pairs": pairs, "source_to_copy": source_to_copy}


func _subtree_has_virtual_changes(node: Node, context: Dictionary) -> bool:
	var pending: Array = [node]
	var seen: Dictionary = {}
	while not pending.is_empty():
		var current := pending.pop_back() as Node
		if seen.has(current.get_instance_id()):
			continue
		seen[current.get_instance_id()] = true
		var state := _state_for_existing(current, context)
		if (
			bool(state.is_new)
			or bool(state.removed)
			or state.parent_node != current.get_parent()
			or str(state.name) != str(current.name)
			or not (state.property_values as Dictionary).is_empty()
		):
			return true
		for child in _virtual_children(current, context, true):
			pending.append(child)
	return false


func _unique_virtual_name(parent: Node, requested: String, context: Dictionary) -> String:
	if _find_virtual_child(parent, requested, context, true) == null:
		return requested
	for suffix in range(2, 10000):
		var candidate := "%s%d" % [requested, suffix]
		if candidate.length() <= MAX_NODE_NAME_LENGTH and _find_virtual_child(parent, candidate, context, true) == null:
			return candidate
	return "GodotXNode"


func _relative_virtual_path(source: Node, target: Node, context: Dictionary) -> Dictionary:
	if source == target:
		return {"ok": true, "path": "."}
	var source_chain: Array = []
	var target_chain: Array = []
	var current := source
	while current != null:
		source_chain.append(current)
		if current == context.scene_root:
			break
		current = _state_for_existing(current, context).get("parent_node") as Node
	current = target
	while current != null:
		target_chain.append(current)
		if current == context.scene_root:
			break
		current = _state_for_existing(current, context).get("parent_node") as Node
	if source_chain.is_empty() or target_chain.is_empty():
		return _error("nodes are outside the current scene")
	if source_chain[-1] != context.scene_root or target_chain[-1] != context.scene_root:
		return _error("nodes are outside the current scene")
	var source_index := source_chain.size() - 1
	var target_index := target_chain.size() - 1
	while source_index >= 0 and target_index >= 0 and source_chain[source_index] == target_chain[target_index]:
		source_index -= 1
		target_index -= 1
	var segments := PackedStringArray()
	for unused in range(source_index + 1):
		segments.append("..")
	for index in range(target_index, -1, -1):
		segments.append(str(_state_for_existing(target_chain[index], context).name))
	return {"ok": true, "path": "." if segments.is_empty() else "/".join(segments)}


func _is_directly_editable_node(node: Node, context: Dictionary) -> bool:
	if node == context.scene_root:
		return true
	var state := _state_for_existing(node, context)
	if state.has("editable"):
		return bool(state.editable)
	return bool(state.get("is_new", false)) or state.get("owner") == context.scene_root


func _resolve_virtual_node(path: String, label: String, context: Dictionary) -> Dictionary:
	var path_result := _parse_node_path(path, label)
	if not bool(path_result.get("ok", false)):
		return path_result
	var current := context.scene_root as Node
	for segment in path_result.segments:
		var child := _find_virtual_child(current, segment, context, false)
		if child == null:
			return _error("%s does not resolve inside the current scene: %s" % [label, path])
		current = child
	return {"ok": true, "node": current}


func _find_virtual_child(parent: Node, name: String, context: Dictionary, include_internal: bool) -> Node:
	for child in _virtual_children(parent, context, include_internal):
		var state := _state_for_existing(child, context)
		if str(state.name) == name:
			return child
	return null


func _virtual_children(parent: Node, context: Dictionary, include_internal: bool) -> Array:
	var order := _ensure_virtual_child_order(parent, context)
	var children: Array = []
	for child in order:
		if not child is Node or not is_instance_valid(child):
			continue
		var state := _state_for_existing(child, context)
		if (
			not bool(state.removed)
			and state.parent_node == parent
			and (include_internal or not bool(state.get("internal", false)))
		):
			children.append(child)
	return children


func _ensure_virtual_child_order(parent: Node, context: Dictionary) -> Array:
	var parent_id := parent.get_instance_id()
	var child_orders: Dictionary = context.child_orders
	if child_orders.has(parent_id):
		return child_orders[parent_id]
	var order: Array = []
	for child in parent.get_children(true):
		if child is Node:
			order.append(child)
	child_orders[parent_id] = order
	return order


func _virtual_append_child(parent: Node, node: Node, context: Dictionary) -> void:
	var order := _ensure_virtual_child_order(parent, context)
	if not order.has(node):
		order.append(node)


func _virtual_remove_child(parent: Node, node: Node, context: Dictionary) -> void:
	var order := _ensure_virtual_child_order(parent, context)
	order.erase(node)


func _virtual_insert_child_at_external_index(
	parent: Node,
	node: Node,
	external_index: int,
	context: Dictionary
) -> void:
	var order := _ensure_virtual_child_order(parent, context)
	order.erase(node)
	var seen_external := 0
	for order_index in range(order.size()):
		var candidate := order[order_index] as Node
		var state := _state_for_existing(candidate, context)
		if bool(state.removed) or state.parent_node != parent or bool(state.get("internal", false)):
			continue
		if seen_external == external_index:
			order.insert(order_index, node)
			return
		seen_external += 1
	order.append(node)


func _physical_child_is_internal(node: Node, parent: Node) -> bool:
	if node == null or parent == null or node.get_parent() != parent:
		return false
	return not parent.get_children(false).has(node)


func _state_for_existing(node: Node, context: Dictionary) -> Dictionary:
	var instance_id := node.get_instance_id()
	if context.states.has(instance_id):
		return context.states[instance_id]
	var state := {
		"node": node,
		"parent_node": node.get_parent(),
		"name": str(node.name),
		"removed": false,
		"is_new": false,
		"owner": node.owner,
		"property_values": {},
		"internal": _physical_child_is_internal(node, node.get_parent()),
		"editable": node == context.scene_root or node.owner == context.scene_root,
	}
	context.states[instance_id] = state
	return state


func _virtual_path(node: Node, context: Dictionary) -> String:
	if node == context.scene_root:
		return "."
	var segments := PackedStringArray()
	var current: Node = node
	var guard := 0
	while current != null and current != context.scene_root and guard <= MAX_OPERATIONS + MAX_NODE_PATH_LENGTH:
		var state := _state_for_existing(current, context)
		segments.append(str(state.name))
		current = state.get("parent_node") as Node
		guard += 1
	if current != context.scene_root:
		return ""
	segments.reverse()
	return "/".join(segments)


func _virtual_is_ancestor(ancestor: Node, node: Node, context: Dictionary) -> bool:
	var current := node
	var guard := 0
	while current != null and guard <= MAX_OWNER_SNAPSHOT_NODES:
		if current == ancestor:
			return true
		var state := _state_for_existing(current, context)
		current = state.get("parent_node") as Node
		guard += 1
	return false


func _snapshot_virtual_owners(node: Node, context: Dictionary) -> Dictionary:
	var records: Array = []
	var pending: Array = [node]
	while not pending.is_empty():
		if records.size() >= MAX_OWNER_SNAPSHOT_NODES:
			return _error("removed subtree exceeds the %d node limit" % MAX_OWNER_SNAPSHOT_NODES)
		var current := pending.pop_back() as Node
		var state := _state_for_existing(current, context)
		records.append({"node": current, "owner": state.owner})
		var children := _virtual_children(current, context, true)
		for child_index in range(children.size() - 1, -1, -1):
			pending.append(children[child_index])
	return {"ok": true, "records": records}


func _finalize_changes(context: Dictionary) -> Array:
	var finalized: Array = []
	var budget := _new_change_budget()
	for raw_change in context.changes:
		var change: Dictionary = (raw_change as Dictionary).duplicate(false)
		var node := change.get("_node") as Node
		var property := str(change.get("_property", ""))
		var raw_before = change.get("_before")
		var before = _resolved_planned_value(raw_before)
		change.erase("_node")
		change.erase("_property")
		change.erase("_before")
		match str(change.get("action", "")):
			"set_property":
				change["before"] = (
					_encode_deferred_node_path_marker(raw_before, budget, context.scene_root)
					if _is_deferred_node_path_marker(raw_before)
					else _encode_change_value(before, budget, context.scene_root, node, true)
				)
				if node != null and is_instance_valid(node):
					change["node_path"] = _actual_scene_path(node, context.scene_root, str(change.get("node_path", "")))
					var actual = node.get(StringName(property))
					change["after"] = _encode_change_value(actual, budget, context.scene_root, node, false)
					change["value_type"] = type_string(typeof(actual))
			"set_script":
				change["before"] = _script_change_path(raw_before)
				if node != null and is_instance_valid(node):
					change["node_path"] = _actual_scene_path(node, context.scene_root, str(change.get("node_path", "")))
					change["after"] = _script_change_path(node.get_script())
			"add_node", "instantiate_scene":
				if node != null and is_instance_valid(node):
					change["node_path"] = _actual_scene_path(node, context.scene_root, str(change.get("node_path", "")))
					change["name"] = str(node.name)
					change["node_type"] = node.get_class()
					var values := {}
					for property_name in change.get("properties", []):
						values[str(property_name)] = _encode_change_value(
							node.get(StringName(property_name)),
							budget,
							context.scene_root,
							node,
							false
						)
					change["property_values"] = values
					change["after"] = {
						"node_path": change.node_path,
						"node_type": change.node_type,
						"name": change.name,
						"properties": values,
					}
			"duplicate_node":
				if node != null and is_instance_valid(node):
					change["node_path"] = _actual_scene_path(node, context.scene_root, str(change.get("node_path", "")))
					change["name"] = str(node.name)
					change["node_type"] = node.get_class()
					change["after"] = {
						"node_path": change.node_path,
						"node_type": change.node_type,
						"name": change.name,
					}
			"rename_node":
				change["before"] = {"node_path": change.get("node_path"), "name": change.get("old_name")}
				if node != null and is_instance_valid(node):
					change["new_path"] = _actual_scene_path(node, context.scene_root, str(change.get("new_path", "")))
					change["new_name"] = str(node.name)
				change["after"] = {"node_path": change.get("new_path"), "name": change.get("new_name")}
			"remove_node":
				change["before"] = {
					"node_path": change.get("node_path"),
					"node_type": change.get("node_type"),
					"name": change.get("name"),
				}
				change["after"] = null
			"reparent_node":
				change["before"] = {
					"node_path": change.get("node_path"),
					"parent_path": change.get("old_parent_path"),
					"index": change.get("old_index"),
					"name": change.get("old_name"),
				}
				if node != null and is_instance_valid(node):
					change["new_path"] = _actual_scene_path(node, context.scene_root, str(change.get("new_path", "")))
					change["new_index"] = node.get_index()
					change["new_name"] = str(node.name)
					var actual_parent := node.get_parent()
					if actual_parent is Node:
						change["new_parent_path"] = _actual_scene_path(
							actual_parent,
							context.scene_root,
							str(change.get("new_parent_path", ""))
						)
				change["after"] = {
					"node_path": change.get("new_path"),
					"parent_path": change.get("new_parent_path"),
					"index": change.get("new_index"),
					"name": change.get("new_name"),
				}
		finalized.append(change)
	return _enforce_change_result_budget(finalized)


func _new_change_budget() -> Dictionary:
	return {
		"remaining_chars": MAX_CHANGE_VALUE_CHARS,
		"remaining_values": MAX_CHANGE_VALUE_COUNT,
	}


func _encode_change_value(
	value: Variant,
	budget: Dictionary = {},
	scene_root: Node = null,
	property_owner: Node = null,
	stored_node_path: bool = false,
	depth: int = 0
) -> Variant:
	if budget.is_empty():
		budget = _new_change_budget()
	if not _consume_change_budget(budget, 1, 8):
		return _change_truncation("value budget exhausted")
	if depth > MAX_CHANGE_DEPTH:
		return _change_truncation("maximum value depth exceeded")
	match typeof(value):
		TYPE_NIL, TYPE_BOOL:
			return value
		TYPE_INT:
			var integer := int(value)
			if integer < -JSON_SAFE_INTEGER_MAX or integer > JSON_SAFE_INTEGER_MAX:
				return {"godot_type": "int64", "value": str(integer)}
			return integer
		TYPE_FLOAT:
			return _encode_change_float(float(value))
		TYPE_STRING, TYPE_STRING_NAME:
			return _encode_change_string(str(value), budget)
		TYPE_NODE_PATH:
			return _encode_change_node_path(value, budget, scene_root, property_owner, stored_node_path)
		TYPE_VECTOR2:
			return {
				"godot_type": "Vector2",
				"x": _encode_change_float(value.x),
				"y": _encode_change_float(value.y),
			}
		TYPE_VECTOR2I:
			return {"godot_type": "Vector2i", "x": value.x, "y": value.y}
		TYPE_VECTOR3:
			return {
				"godot_type": "Vector3",
				"x": _encode_change_float(value.x),
				"y": _encode_change_float(value.y),
				"z": _encode_change_float(value.z),
			}
		TYPE_VECTOR3I:
			return {"godot_type": "Vector3i", "x": value.x, "y": value.y, "z": value.z}
		TYPE_VECTOR4:
			return {
				"godot_type": "Vector4",
				"x": _encode_change_float(value.x),
				"y": _encode_change_float(value.y),
				"z": _encode_change_float(value.z),
				"w": _encode_change_float(value.w),
			}
		TYPE_VECTOR4I:
			return {"godot_type": "Vector4i", "x": value.x, "y": value.y, "z": value.z, "w": value.w}
		TYPE_COLOR:
			return {
				"godot_type": "Color",
				"r": _encode_change_float(value.r),
				"g": _encode_change_float(value.g),
				"b": _encode_change_float(value.b),
				"a": _encode_change_float(value.a),
			}
		TYPE_OBJECT:
			if value is Resource:
				return _encode_change_resource(value, budget)
			if value is Object:
				return {"godot_type": "StoredObject", "object_type": value.get_class(), "writable": false}
		TYPE_ARRAY, TYPE_PACKED_BYTE_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY, TYPE_PACKED_STRING_ARRAY, TYPE_PACKED_VECTOR2_ARRAY, TYPE_PACKED_VECTOR3_ARRAY, TYPE_PACKED_COLOR_ARRAY, TYPE_PACKED_VECTOR4_ARRAY:
			return _encode_change_array(value, budget, scene_root, property_owner, stored_node_path, depth)
		TYPE_DICTIONARY:
			return _encode_change_dictionary(value, budget, scene_root, property_owner, stored_node_path, depth)
	return {
		"godot_type": "StoredValue",
		"value_type": type_string(typeof(value)),
		"summary": _encode_change_string(str(value), budget),
		"writable": false,
	}


func _encode_change_float(value: float) -> Variant:
	if not is_nan(value) and not is_inf(value):
		return value
	return {
		"godot_type": "StoredFloat",
		"value": "nan" if is_nan(value) else ("-inf" if value < 0.0 else "inf"),
		"writable": false,
	}


func _encode_change_string(value: String, budget: Dictionary) -> Variant:
	var original_size := value.length()
	var available := maxi(0, int(budget.get("remaining_chars", 0)) / 6)
	var limit := mini(MAX_CHANGE_STRING_CHARS, available)
	if original_size <= limit:
		_consume_change_budget(budget, 0, original_size * 6)
		return value
	var preview_size := maxi(0, mini(limit, MAX_CHANGE_STRING_CHARS))
	_consume_change_budget(budget, 0, preview_size * 6)
	return {
		"truncated": true,
		"original_size": original_size,
		"preview": value.left(preview_size),
		"summary": "string truncated by change-result budget",
	}


func _encode_change_array(
	value: Variant,
	budget: Dictionary,
	scene_root: Node,
	property_owner: Node,
	stored_node_path: bool,
	depth: int
) -> Variant:
	var original_size := int(value.size())
	var item_count := mini(original_size, MAX_CHANGE_ARRAY_ITEMS)
	var items: Array = []
	for item_index in range(item_count):
		if int(budget.get("remaining_values", 0)) <= 0 or int(budget.get("remaining_chars", 0)) <= 0:
			break
		items.append(_encode_change_value(
			value[item_index], budget, scene_root, property_owner, stored_node_path, depth + 1
		))
	if items.size() == original_size:
		return items
	return {
		"items": items,
		"truncated": true,
		"original_size": original_size,
		"summary": "array truncated by change-result budget",
	}


func _encode_change_dictionary(
	value: Dictionary,
	budget: Dictionary,
	scene_root: Node,
	property_owner: Node,
	stored_node_path: bool,
	depth: int
) -> Dictionary:
	var encoded := {}
	var keys := value.keys()
	keys.sort_custom(func(left, right): return str(left) < str(right))
	var encoded_count := 0
	for key in keys:
		if encoded_count >= MAX_CHANGE_ARRAY_ITEMS or int(budget.get("remaining_values", 0)) <= 0:
			break
		var key_text := str(key)
		encoded[str(_encode_change_string(key_text, budget))] = _encode_change_value(
			value[key], budget, scene_root, property_owner, stored_node_path, depth + 1
		)
		encoded_count += 1
	if encoded_count < keys.size():
		encoded["__truncation"] = {
			"truncated": true,
			"original_size": keys.size(),
			"summary": "dictionary truncated by change-result budget",
		}
	return encoded


func _encode_change_node_path(
	value: NodePath,
	budget: Dictionary,
	scene_root: Node,
	property_owner: Node,
	stored_semantics: bool
) -> Dictionary:
	var stored_path := str(value)
	if value.is_empty():
		return {"godot_type": NODE_PATH_TAG, "path": ""}
	if not stored_semantics and property_owner != null and scene_root != null:
		var target := property_owner.get_node_or_null(value)
		if target is Node and (target == scene_root or scene_root.is_ancestor_of(target)):
			return {
				"godot_type": NODE_PATH_TAG,
				"path": "." if target == scene_root else str(scene_root.get_path_to(target)),
			}
	return {
		"godot_type": "StoredNodePath",
		"stored_path": _encode_change_string(stored_path, budget),
		"writable": false,
		"summary": "stored path is relative to its original property owner state",
	}


func _encode_deferred_node_path_marker(marker: Dictionary, budget: Dictionary, scene_root: Node) -> Dictionary:
	if bool(marker.get("empty", false)):
		return {"godot_type": NODE_PATH_TAG, "path": ""}
	var target := marker.get("target") as Node
	if target != null and scene_root != null and (target == scene_root or scene_root.is_ancestor_of(target)):
		return {
			"godot_type": NODE_PATH_TAG,
			"path": "." if target == scene_root else str(scene_root.get_path_to(target)),
		}
	return {
		"godot_type": "StoredNodePath",
		"stored_path": _encode_change_string(str(marker.get("resolved_value", NodePath(""))), budget),
		"writable": false,
		"summary": "deferred target is no longer inside the edited scene",
	}


func _encode_change_resource(resource: Resource, budget: Dictionary) -> Dictionary:
	var path := resource.resource_path
	var canonical_path := (
		not path.is_empty()
		and not path.contains("::")
		and _resource_path_error(path).is_empty()
	)
	var uid := -1
	if canonical_path:
		uid = ResourceLoader.get_resource_uid(path)
	if canonical_path or uid >= 0:
		var result := {
			"godot_type": RESOURCE_TAG,
			"resource_type": resource.get_class(),
		}
		if canonical_path:
			result["path"] = path
		if uid >= 0:
			result["uid"] = ResourceUID.id_to_text(uid)
		return result
	return {
		"godot_type": "StoredResource",
		"resource_type": resource.get_class(),
		"resource_name": _encode_change_string(resource.resource_name, budget),
		"stored_path": _encode_change_string(path, budget),
		"writable": false,
		"summary": "built-in or subresource values cannot be written by Resource tag",
	}


static func _script_change_path(value: Variant) -> Variant:
	if not value is Script:
		return null
	var path := (value as Script).resource_path
	if path.is_empty() or path.contains("::") or not _resource_path_error(path).is_empty():
		return null
	return path


func _consume_change_budget(budget: Dictionary, values: int, chars: int) -> bool:
	if int(budget.get("remaining_values", 0)) < values or int(budget.get("remaining_chars", 0)) < chars:
		return false
	budget.remaining_values = int(budget.remaining_values) - values
	budget.remaining_chars = int(budget.remaining_chars) - chars
	return true


func _change_truncation(summary: String) -> Dictionary:
	return {"truncated": true, "summary": summary}


func _is_deferred_node_path_marker(value: Variant) -> bool:
	return value is Dictionary and bool(value.get("__godetx_deferred_node_path", false))


func _enforce_change_result_budget(changes: Array) -> Array:
	var rendered := JSON.stringify(changes)
	if rendered.length() <= MAX_CHANGE_RESULT_CHARS:
		return changes
	var original_chars := rendered.length()
	for change_index in range(changes.size() - 1, -1, -1):
		var change := changes[change_index] as Dictionary
		for field in ["before", "after", "property_values"]:
			if change.has(field):
				change[field] = _change_truncation("change details removed by total result budget")
		rendered = JSON.stringify(changes)
		if rendered.length() <= MAX_CHANGE_RESULT_CHARS:
			return changes
	return [{
		"truncated": true,
		"original_size": changes.size(),
		"original_chars": original_chars,
		"summary": "change list replaced because it exceeded the total result budget",
	}]


func _actual_scene_path(node: Node, scene_root: Node, fallback: String) -> String:
	if node == scene_root:
		return "."
	if scene_root != null and is_instance_valid(scene_root) and scene_root.is_ancestor_of(node):
		return str(scene_root.get_path_to(node))
	return fallback


func _commit_plan(undo_redo, scene_root: Node, action_name: String, context: Dictionary) -> void:
	if undo_redo is EditorUndoRedoManager:
		undo_redo.create_action(action_name, UndoRedo.MERGE_DISABLE, scene_root, false, true)
	else:
		undo_redo.create_action(action_name, UndoRedo.MERGE_DISABLE, false)
	for step in context.do_steps:
		_register_step(undo_redo, step, true)
	for reference in context.do_references:
		undo_redo.add_do_reference(reference)
	var undo_groups: Array = context.undo_groups
	for group_index in range(undo_groups.size() - 1, -1, -1):
		for step in undo_groups[group_index]:
			_register_step(undo_redo, step, false)
	for reference in context.undo_references:
		undo_redo.add_undo_reference(reference)
	undo_redo.commit_action(true)


func _register_step(undo_redo, step: Dictionary, is_do: bool) -> void:
	var target := step.object as Object
	if step.kind == "property":
		if is_do:
			undo_redo.add_do_property(target, step.property, step.value)
		else:
			undo_redo.add_undo_property(target, step.property, step.value)
		return
	var arguments: Array = step.arguments
	if undo_redo is EditorUndoRedoManager:
		var call_arguments: Array = [target, step.method]
		call_arguments.append_array(arguments)
		undo_redo.callv("add_do_method" if is_do else "add_undo_method", call_arguments)
	else:
		var callable := Callable(target, step.method).bindv(arguments)
		if is_do:
			undo_redo.add_do_method(callable)
		else:
			undo_redo.add_undo_method(callable)


func _remember_result(
	operation_id: String,
	scene_id: String,
	scene_revision: String,
	operations: Array,
	result: Dictionary
) -> void:
	_operation_journal[operation_id] = {
		"scene_id": scene_id,
		"scene_revision": scene_revision,
		"result_revision": str(result.get("scene_revision", "")),
		"operations": operations.duplicate(true),
		"result": result.duplicate(true),
	}
	_operation_order.append(operation_id)
	while _operation_order.size() > MAX_JOURNAL_ENTRIES:
		var oldest := str(_operation_order.pop_front())
		_operation_journal.erase(oldest)


static func _method_step(target: Object, method: StringName, arguments: Array) -> Dictionary:
	return {"kind": "method", "object": target, "method": method, "arguments": arguments}


static func _property_step(target: Object, property: StringName, value: Variant) -> Dictionary:
	return {"kind": "property", "object": target, "property": property, "value": value}


static func _parse_node_path(path: String, label: String) -> Dictionary:
	if path.is_empty() or path.length() > MAX_NODE_PATH_LENGTH or path != path.strip_edges():
		return _error("%s is empty, too long, or has edge whitespace" % label)
	if path == ".":
		return {"ok": true, "segments": PackedStringArray()}
	if path.begins_with("/") or path.contains(":") or path.contains("%") or path.contains("\\"):
		return _error("%s must be a safe path relative to the current scene root" % label)
	var segments := path.split("/", true)
	for segment in segments:
		var name_error := _node_name_error(segment)
		if not name_error.is_empty():
			return _error("%s contains an invalid segment: %s" % [label, name_error])
	return {"ok": true, "segments": segments}


static func _node_name_error(name: String) -> String:
	if name.is_empty():
		return "name is empty"
	if name.length() > MAX_NODE_NAME_LENGTH:
		return "name exceeds %d characters" % MAX_NODE_NAME_LENGTH
	if name != name.strip_edges():
		return "leading or trailing whitespace is not allowed"
	for index in range(name.length()):
		var code := name.unicode_at(index)
		var character := name.substr(index, 1)
		if code < 32 or code == 127:
			return "control characters are not allowed"
		if character in [".", ":", "@", "/", "\"", "%", "\\"]:
			return "reserved character %s is not allowed" % character
	return ""


static func _property_name_error(property: String) -> String:
	if property.is_empty() or property.length() > MAX_PROPERTY_NAME_LENGTH:
		return "name is empty or exceeds %d characters" % MAX_PROPERTY_NAME_LENGTH
	for segment in property.split("/", true):
		if not _is_ascii_identifier(segment):
			return "each flat property segment must be an ASCII identifier"
	return ""


static func _node_path_value_error(path: String) -> String:
	if path.is_empty():
		return ""
	var parsed := _parse_node_path(path, "path")
	return "" if bool(parsed.get("ok", false)) else str(parsed.get("error", "invalid path"))


static func _resource_path_error(path: String) -> String:
	if path.is_empty() or path.length() > MAX_RESOURCE_PATH_LENGTH:
		return "path is empty or too long"
	if path != path.strip_edges() or not path.begins_with("res://"):
		return "path must be a canonical res:// project path"
	if path.contains("\\"):
		return "backslashes are not allowed"
	for index in range(path.length()):
		var code := path.unicode_at(index)
		if code < 32 or code == 127:
			return "control characters are not allowed"
	var relative := path.trim_prefix("res://")
	if relative.is_empty():
		return "path must identify a project resource"
	for segment in relative.split("/", true):
		if segment.is_empty() or segment in [".", ".."]:
			return "empty and traversal path segments are not allowed"
	return ""


static func _is_resource_class(class_name_value: String) -> bool:
	return _is_native_resource_class(class_name_value)


static func _is_native_resource_class(class_name_value: String) -> bool:
	var native_class_name := StringName(class_name_value)
	return (
		ClassDB.class_exists(native_class_name)
		and ClassDB.class_get_api_type(native_class_name) == ClassDB.API_CORE
		and (
			native_class_name == &"Resource"
			or ClassDB.is_parent_class(native_class_name, &"Resource")
		)
	)


static func _class_is_or_inherits(class_name_value: String, parent_name_value: String) -> bool:
	var native_class_name := StringName(class_name_value)
	var parent_name := StringName(parent_name_value)
	return native_class_name == parent_name or ClassDB.is_parent_class(native_class_name, parent_name)


static func _is_ascii_identifier(value: String) -> bool:
	if value.is_empty():
		return false
	for index in range(value.length()):
		var code := value.unicode_at(index)
		var valid := code == 95 or (code >= 65 and code <= 90) or (code >= 97 and code <= 122)
		if index > 0:
			valid = valid or (code >= 48 and code <= 57)
		if not valid:
			return false
	return true


static func _is_safe_operation_id(value: String) -> bool:
	if value.is_empty() or value.length() > MAX_OPERATION_ID_LENGTH:
		return false
	for index in range(value.length()):
		var code := value.unicode_at(index)
		var valid := (
			(code >= 48 and code <= 57)
			or (code >= 65 and code <= 90)
			or (code >= 97 and code <= 122)
			or code in [45, 46, 58, 95]
		)
		if not valid:
			return false
	return true


static func _has_exact_keys(value: Dictionary, expected: Array) -> bool:
	if value.size() != expected.size():
		return false
	for key in expected:
		if not value.has(key):
			return false
	return true


static func _first_unknown_key(value: Dictionary, allowed: Array) -> String:
	for key in value:
		if not key is String or not allowed.has(key):
			var rendered := str(key)
			return rendered if not rendered.is_empty() else "<empty key>"
	return ""


static func _free_uncommitted_nodes(nodes: Array) -> void:
	for node in nodes:
		if node is Node and is_instance_valid(node) and node.get_parent() == null:
			node.free()


static func _scene_id(scene_root: Node) -> String:
	return "scene_%s" % str(scene_root.get_instance_id())


static func scene_revision_for(scene_root: Node, undo_redo) -> String:
	if scene_root == null or not is_instance_valid(scene_root):
		return "scene_unavailable"
	if undo_redo is UndoRedo:
		return "undo_v%d" % undo_redo.get_version()
	if undo_redo is EditorUndoRedoManager:
		var history_id := int(undo_redo.get_object_history_id(scene_root))
		if history_id >= 0:
			var history := undo_redo.get_history_undo_redo(history_id) as UndoRedo
			if history is UndoRedo:
				return "history_%d_v%d" % [history_id, history.get_version()]
		return ""
	return "scene_%s_untracked" % str(scene_root.get_instance_id())


static func _operation_error(index: int, message: String) -> Dictionary:
	return {"ok": false, "error": "operations[%d]: %s" % [index, message], "operation_index": index}


static func _error(message: String) -> Dictionary:
	return {"ok": false, "error": message}
