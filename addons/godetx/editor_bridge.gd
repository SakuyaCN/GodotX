@tool
class_name GodetXEditorBridge
extends RefCounted

const EditorSceneMutator := preload("res://addons/godetx/editor_scene_mutator.gd")
const GodotIntelligence := preload("res://addons/godetx/godot_intelligence.gd")
const DEFAULT_TREE_DEPTH := 6
const MAX_TREE_DEPTH := 8
const DEFAULT_NODE_LIMIT := 200
const MAX_NODE_LIMIT := 500
const MAX_SELECTION_LIMIT := 128
const DEFAULT_PROPERTY_LIMIT := 128
const MAX_PROPERTY_LIMIT := 256
const DEFAULT_DEPENDENCY_LIMIT := 128
const MAX_DEPENDENCY_LIMIT := 256
const MAX_GROUPS := 16
const MAX_COLLECTION_ITEMS := 64
const MAX_SERIALIZE_DEPTH := 4
const MAX_SERIALIZED_VALUES := 2048
const MAX_SERIALIZED_STRING_CHARS := 262144
const MAX_STRING_LENGTH := 4096
const MAX_PROPERTY_SCAN := 1024
const MAX_NODE_PATH_LENGTH := 512
const MAX_RESOURCE_PATH_LENGTH := 1024
const MAX_TURN_SCENE_LEASES := 64
const JSON_SAFE_INTEGER_MAX := 9_007_199_254_740_991
const SCENE_BOUND_TOOLS := {
	"scene_get_tree": true,
	"editor_get_selection": true,
	"node_get_properties": true,
	"scene_apply_operations": true,
}

var editor_interface: EditorInterface
var editor_undo_redo: EditorUndoRedoManager
var _scene_mutator
var _godot_intelligence
var _game_debugger
var _runtime_automation_enabled := false


func _init(
	value: EditorInterface = null,
	undo_redo_value: EditorUndoRedoManager = null,
	game_debugger_value = null,
	runtime_automation_enabled_value: bool = false
) -> void:
	editor_interface = value
	editor_undo_redo = undo_redo_value
	_game_debugger = game_debugger_value
	_runtime_automation_enabled = runtime_automation_enabled_value
	_scene_mutator = EditorSceneMutator.new(value, undo_redo_value)
	_godot_intelligence = GodotIntelligence.new()


func set_runtime_automation_enabled(enabled: bool) -> void:
	_runtime_automation_enabled = enabled


func execute(tool: String, args: Dictionary, scene_lease: Dictionary = {}) -> Dictionary:
	var scene_root: Node
	if SCENE_BOUND_TOOLS.has(tool):
		var lease_result := validate_scene_lease(scene_lease)
		if not bool(lease_result.get("ok", false)):
			return lease_result
		scene_root = lease_result.get("scene_root") as Node
	match tool:
		"scene_get_tree":
			return _scene_get_tree_from_root(scene_root, args)
		"editor_get_selection":
			if scene_root != _edited_scene_root():
				return _scene_context_error(
					"Editor selection belongs to a different active scene",
					scene_lease,
					_edited_scene_root()
				)
			return _editor_get_selection(args, scene_root)
		"node_get_properties":
			return _node_get_properties_from_root(scene_root, args)
		"resource_inspect":
			return _resource_inspect(args)
		"godot_api_query":
			return _godot_intelligence.execute(args)
		"scene_apply_operations":
			return _scene_mutator.execute(tool, args, scene_root)
		"game_debug_start":
			return _game_debug_start(args)
		"game_debug_status":
			return _game_debug_status(args)
		"game_debug_stop":
			return _game_debug_stop(args)
		"game_automation_run":
			return _game_automation_run(args)
		"game_automation_status":
			return _game_automation_status(args)
		"game_automation_cancel":
			return _game_automation_cancel(args)
		_:
			return _error("Unknown editor tool: %s" % tool)


func execute_deferred(
	tool: String,
	args: Dictionary,
	completed: Callable
) -> Dictionary:
	if tool != "game_capture_screenshot":
		return _error("Editor tool does not support deferred execution: %s" % tool)
	if _game_debugger == null:
		return _error("GodotX game visual capture is unavailable in this editor")
	if not completed.is_valid():
		return _error("A deferred editor tool completion callback is required")
	var run_id := str(args.get("run_id", "")).strip_edges()
	if run_id.is_empty():
		return _error("run_id is required to capture the running game")
	var max_dimension_value: Variant = args.get("max_dimension", 1600)
	var max_dimension_result := _bounded_json_integer(max_dimension_value, 64, 2048)
	if not bool(max_dimension_result.get("ok", false)):
		return _error("max_dimension must be an integer from 64 to 2048")
	var max_dimension := int(max_dimension_result.get("value", 0))
	return _game_debugger.capture_screenshot(
		run_id,
		max_dimension,
		completed
	)


func cancel_deferred(tool: String, operation_id: String, reason: String) -> bool:
	if tool != "game_capture_screenshot" or _game_debugger == null:
		return false
	return _game_debugger.cancel_screenshot(operation_id, reason)


func _game_debug_start(args: Dictionary) -> Dictionary:
	if editor_interface == null or _game_debugger == null:
		return _error("GodotX game debugging is unavailable in this editor")
	if editor_interface.is_playing_scene():
		return _error("A game is already running; GodotX will not replace or adopt it")
	var mode := str(args.get("mode", ""))
	var scene_path := ""
	match mode:
		"main":
			var main_result := _configured_main_scene_path()
			if not bool(main_result.get("ok", false)):
				return main_result
			scene_path = str(main_result.get("path", ""))
		"current":
			var current_root := _edited_scene_root()
			if current_root == null or not is_instance_valid(current_root):
				return _error("There is no current edited scene to run")
			var current_result := _validated_game_scene_path(str(current_root.scene_file_path))
			if not bool(current_result.get("ok", false)):
				return current_result
			scene_path = str(current_result.get("path", ""))
		"scene":
			var scene_result := _validated_game_scene_path(str(args.get("scene_path", "")))
			if not bool(scene_result.get("ok", false)):
				return scene_result
			scene_path = str(scene_result.get("path", ""))
		_:
			return _error("mode must be main, current, or scene")

	var armed_result: Dictionary = _game_debugger.arm_run(mode, scene_path)
	if not bool(armed_result.get("ok", false)):
		return armed_result
	match mode:
		"main":
			editor_interface.play_main_scene()
		"current", "scene":
			# Use the resolved path so a later editor-tab change cannot retarget the run.
			editor_interface.play_custom_scene(scene_path)
	var run_id := str(armed_result.get("run_id", ""))
	if not _game_debugger.owns_run(run_id):
		_game_debugger.cancel_armed_run(run_id, "The Godot editor did not accept the play request")
		return _error("The Godot editor did not start the requested game scene")
	armed_result["launch_requested"] = true
	armed_result["scene_path"] = scene_path
	return armed_result


func _game_debug_status(args: Dictionary) -> Dictionary:
	if _game_debugger == null:
		return _error("GodotX game debugging is unavailable in this editor")
	var history_limit := _bounded_int(args.get("history_limit", 100), 100, 1, 500)
	var after_seq := _bounded_int(args.get("after_seq", 0), 0, 0, JSON_SAFE_INTEGER_MAX)
	return _game_debugger.snapshot(history_limit, after_seq)


func _game_debug_stop(args: Dictionary) -> Dictionary:
	if _game_debugger == null:
		return _error("GodotX game debugging is unavailable in this editor")
	var run_id := str(args.get("run_id", ""))
	if run_id.is_empty():
		return _error("run_id is required to stop a GodotX game")
	return _game_debugger.stop_owned(run_id)


func _game_automation_run(args: Dictionary) -> Dictionary:
	if not _runtime_automation_enabled:
		return _error("Runtime simulation automation is disabled in GodotX settings")
	if _game_debugger == null:
		return _error("GodotX runtime automation is unavailable in this editor")
	var run_id := str(args.get("run_id", "")).strip_edges()
	if run_id.is_empty():
		return _error("run_id is required to run game automation")
	var steps_value = args.get("steps", [])
	if not steps_value is Array:
		return _error("steps must be an array")
	return _game_debugger.automation_run(
		run_id,
		(steps_value as Array).duplicate(true),
		bool(args.get("stop_on_failure", true))
	)


func _game_automation_status(args: Dictionary) -> Dictionary:
	if _game_debugger == null:
		return _error("GodotX runtime automation is unavailable in this editor")
	var run_id := str(args.get("run_id", "")).strip_edges()
	var automation_id := str(args.get("automation_id", "")).strip_edges()
	if run_id.is_empty() or automation_id.is_empty():
		return _error("run_id and automation_id are required to inspect game automation")
	return _game_debugger.automation_status(run_id, automation_id)


func _game_automation_cancel(args: Dictionary) -> Dictionary:
	if not _runtime_automation_enabled:
		return _error("Runtime simulation automation is disabled in GodotX settings")
	if _game_debugger == null:
		return _error("GodotX runtime automation is unavailable in this editor")
	var run_id := str(args.get("run_id", "")).strip_edges()
	var automation_id := str(args.get("automation_id", "")).strip_edges()
	if run_id.is_empty() or automation_id.is_empty():
		return _error("run_id and automation_id are required to cancel game automation")
	return _game_debugger.automation_cancel(run_id, automation_id)


func _configured_main_scene_path() -> Dictionary:
	var configured := str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if configured.begins_with("uid://"):
		var resource_id := ResourceUID.text_to_id(configured)
		if resource_id < 0:
			return _error("The configured main scene UID is invalid")
		configured = ResourceUID.get_id_path(resource_id)
	if configured.is_empty():
		return _error("The project does not have a configured main scene")
	return _validated_game_scene_path(configured)


func _validated_game_scene_path(raw_path: String) -> Dictionary:
	var normalized := _normalize_resource_path(raw_path)
	if not bool(normalized.get("ok", false)):
		return normalized
	var scene_path := str(normalized.get("path", ""))
	var lower_path := scene_path.to_lower()
	if not lower_path.ends_with(".tscn") and not lower_path.ends_with(".scn"):
		return _error("Game scene path must reference a .tscn or .scn resource")
	if not ResourceLoader.exists(scene_path):
		return _error("Game scene does not exist: %s" % scene_path)
	var packed_scene: PackedScene = ResourceLoader.load(scene_path, "PackedScene") as PackedScene
	if packed_scene == null:
		return _error("Game scene is not a PackedScene: %s" % scene_path)
	return {"ok": true, "path": scene_path}


func capture_open_scene_context() -> Dictionary:
	var leases: Dictionary = {}
	var primary_scene_id := ""
	if editor_interface == null:
		return {"primary_scene_id": primary_scene_id, "leases": leases}
	var primary_root := _edited_scene_root()
	var roots: Array[Node] = []
	if primary_root != null and is_instance_valid(primary_root):
		roots.append(primary_root)
	for root_value in editor_interface.get_open_scene_roots():
		var root := root_value as Node
		if root != null and is_instance_valid(root) and not roots.has(root):
			roots.append(root)
	for root in roots:
		if leases.size() >= MAX_TURN_SCENE_LEASES:
			break
		var lease := _capture_scene_lease_for_root(root)
		if root != primary_root and not bool(lease.get("available", false)):
			continue
		var scene_id := str(lease.get("scene_id", ""))
		if not scene_id.is_empty():
			leases[scene_id] = lease
			if root == primary_root:
				primary_scene_id = scene_id
	return {"primary_scene_id": primary_scene_id, "leases": leases}


func capture_current_scene_lease() -> Dictionary:
	var context := capture_open_scene_context()
	var primary_scene_id := str(context.get("primary_scene_id", ""))
	var leases_value = context.get("leases", {})
	if primary_scene_id.is_empty() or not leases_value is Dictionary:
		return _empty_scene_lease()
	var lease_value = (leases_value as Dictionary).get(primary_scene_id)
	return (lease_value as Dictionary).duplicate(true) if lease_value is Dictionary else _empty_scene_lease()


func validate_scene_lease(scene_lease: Dictionary) -> Dictionary:
	if not bool(scene_lease.get("has_scene", false)):
		return _scene_context_error("This task was not bound to an open scene", scene_lease, null)
	var root_reference = scene_lease.get("root_ref")
	if not root_reference is WeakRef:
		return _scene_context_error("Scene lease is missing its host identity", scene_lease, null)
	var scene_root := root_reference.get_ref() as Node
	if scene_root == null or not is_instance_valid(scene_root):
		return _scene_context_error("The target scene was closed after this task started", scene_lease, null)
	if editor_interface != null:
		var still_open := false
		for open_root_value in editor_interface.get_open_scene_roots():
			if open_root_value == scene_root:
				still_open = true
				break
		if not still_open:
			return _scene_context_error("The target scene is no longer open", scene_lease, scene_root)
	var validation := _validate_scene_lease_for_root(scene_root, scene_lease)
	if bool(validation.get("ok", false)):
		validation["scene_root"] = scene_root
	return validation


func _validate_scene_lease_for_root(scene_root: Node, scene_lease: Dictionary) -> Dictionary:
	if scene_root == null or not is_instance_valid(scene_root):
		return _scene_context_error("The target scene is unavailable", scene_lease, scene_root)
	var expected_scene_id := str(scene_lease.get("scene_id", ""))
	var expected_scene_path := str(scene_lease.get("scene_path", ""))
	var expected_revision := str(scene_lease.get("scene_revision", ""))
	if expected_scene_id.is_empty() or expected_revision.is_empty():
		return _scene_context_error("The target scene does not have a safe editor revision", scene_lease, scene_root)
	if _scene_id(scene_root) != expected_scene_id:
		return _scene_context_error("The target scene instance changed after this task started", scene_lease, scene_root)
	if str(scene_root.scene_file_path) != expected_scene_path:
		return _scene_context_error("The target scene path changed after this task started", scene_lease, scene_root)
	var current_revision := _scene_revision(scene_root)
	if current_revision.is_empty() or current_revision != expected_revision:
		return _scene_context_error("The target scene was modified outside this task", scene_lease, scene_root)
	return {"ok": true}


func _capture_scene_lease_for_root(scene_root: Node) -> Dictionary:
	if scene_root == null or not is_instance_valid(scene_root):
		return _empty_scene_lease()
	var revision := _scene_revision(scene_root)
	return {
		"has_scene": true,
		"available": not revision.is_empty(),
		"scene_id": _scene_id(scene_root),
		"scene_path": str(scene_root.scene_file_path),
		"scene_revision": revision,
		"scene_root_name": str(scene_root.name),
		"scene_root_type": scene_root.get_class(),
		"root_ref": weakref(scene_root),
	}


static func _empty_scene_lease() -> Dictionary:
	return {
		"has_scene": false,
		"available": false,
		"scene_id": "",
		"scene_path": "",
		"scene_revision": "",
		"scene_root_name": "",
		"scene_root_type": "",
	}


func _scene_context_error(message: String, expected: Dictionary, current_root: Node) -> Dictionary:
	var current_scene_id := ""
	var current_scene_path := ""
	var current_revision := ""
	if current_root != null and is_instance_valid(current_root):
		current_scene_id = _scene_id(current_root)
		current_scene_path = str(current_root.scene_file_path)
		current_revision = _scene_revision(current_root)
	return {
		"ok": false,
		"error_code": "EDITOR_SCENE_CONTEXT_CHANGED",
		"error": "%s. No editor scene operation was executed." % message,
		"expected_scene_id": str(expected.get("scene_id", "")),
		"expected_scene_path": str(expected.get("scene_path", "")),
		"expected_scene_revision": str(expected.get("scene_revision", "")),
		"current_scene_id": current_scene_id,
		"current_scene_path": current_scene_path,
		"current_scene_revision": current_revision,
	}


func _scene_get_tree(args: Dictionary) -> Dictionary:
	var scene_root := _edited_scene_root()
	if scene_root == null:
		return _error("No scene is currently open in the editor")
	return _scene_get_tree_from_root(scene_root, args)


func _scene_get_tree_from_root(scene_root: Node, args: Dictionary) -> Dictionary:
	if scene_root == null or not is_instance_valid(scene_root):
		return _error("Scene root is unavailable")
	var max_depth := _bounded_int(args.get("max_depth"), DEFAULT_TREE_DEPTH, 0, MAX_TREE_DEPTH)
	var max_nodes := _bounded_int(args.get("max_nodes"), DEFAULT_NODE_LIMIT, 1, MAX_NODE_LIMIT)
	var include_internal := bool(args.get("include_internal", false))
	var requested_path := str(args.get("root_path", ".")).strip_edges()
	var resolved := _resolve_scene_node(scene_root, requested_path)
	if not bool(resolved.get("ok", false)):
		return resolved
	var subtree_root := resolved.get("node") as Node
	var state := {"count": 0, "truncated": false}
	var tree: Variant = _build_node_tree(
		subtree_root,
		scene_root,
		0,
		max_depth,
		max_nodes,
		include_internal,
		state
	)
	var revision := _scene_revision(scene_root)
	if revision.is_empty():
		return _error("Editor undo/redo manager is unavailable; live scene tools cannot run safely")
	return {
		"ok": true,
		"scene_id": _scene_id(scene_root),
		"scene_revision": revision,
		"scene_path": _limited_string(scene_root.scene_file_path, MAX_RESOURCE_PATH_LENGTH),
		"scene_root": _node_summary(scene_root, scene_root),
		"tree": tree,
		"node_count": int(state.count),
		"truncated": bool(state.truncated),
		"limits": {
			"max_depth": max_depth,
			"max_nodes": max_nodes,
			"include_internal": include_internal,
		},
	}


func _editor_get_selection(args: Dictionary, scene_root_override: Node = null) -> Dictionary:
	if editor_interface == null:
		return _error("EditorInterface is unavailable")
	var scene_root := scene_root_override if scene_root_override != null else _edited_scene_root()
	var limit := _bounded_int(args.get("limit"), 64, 1, MAX_SELECTION_LIMIT)
	var selection := editor_interface.get_selection()
	if selection == null:
		return _error("Editor selection is unavailable")
	var selected_nodes := selection.get_selected_nodes()
	var nodes: Array = []
	for selected_node in selected_nodes:
		if nodes.size() >= limit:
			break
		if selected_node is Node and is_instance_valid(selected_node):
			nodes.append(_node_summary(selected_node, scene_root))
	var raw_selected_paths := editor_interface.get_selected_paths()
	var selected_paths: Array[String] = []
	for selected_path in raw_selected_paths:
		if selected_paths.size() >= limit:
			break
		selected_paths.append(_limited_string(str(selected_path), MAX_RESOURCE_PATH_LENGTH))
	var result := {
		"ok": true,
		"scene_id": _scene_id(scene_root) if scene_root != null else "",
		"scene_revision": _scene_revision(scene_root),
		"scene_path": str(scene_root.scene_file_path) if scene_root != null else "",
		"nodes": nodes,
		"node_count": selected_nodes.size(),
		"filesystem_paths": selected_paths,
		"filesystem_path_count": raw_selected_paths.size(),
		"filesystem_paths_truncated": raw_selected_paths.size() > selected_paths.size(),
		"truncated": (
			selected_nodes.size() > nodes.size()
			or raw_selected_paths.size() > selected_paths.size()
		),
	}
	var inspector := editor_interface.get_inspector()
	if inspector != null and inspector.has_method("get_edited_object"):
		var edited_object = inspector.call("get_edited_object")
		if edited_object is Node:
			result["inspector_object"] = _node_summary(edited_object, scene_root)
		elif edited_object is Resource:
			result["inspector_object"] = _resource_reference(edited_object)
	return result


func _node_get_properties(args: Dictionary) -> Dictionary:
	var scene_root := _edited_scene_root()
	if scene_root == null:
		return _error("No scene is currently open in the editor")
	return _node_get_properties_from_root(scene_root, args)


func _node_get_properties_from_root(scene_root: Node, args: Dictionary) -> Dictionary:
	if scene_root == null or not is_instance_valid(scene_root):
		return _error("Scene root is unavailable")
	var requested_scene_id := str(args.get("scene_id", ""))
	if not requested_scene_id.is_empty() and requested_scene_id != _scene_id(scene_root):
		return _error("The current scene changed after it was inspected")
	var node_path := str(args.get("node_path", ".")).strip_edges()
	var resolved := _resolve_scene_node(scene_root, node_path)
	if not bool(resolved.get("ok", false)):
		return resolved
	var node := resolved.get("node") as Node
	var inspection := _inspect_object_properties(node, scene_root, args)
	return {
		"ok": true,
		"scene_id": _scene_id(scene_root),
		"scene_revision": _scene_revision(scene_root),
		"scene_path": str(scene_root.scene_file_path),
		"node": _node_summary(node, scene_root),
		"properties": inspection.properties,
		"property_count": inspection.property_count,
		"property_list_count": inspection.property_list_count,
		"properties_scanned": inspection.properties_scanned,
		"serialization_truncated": inspection.serialization_truncated,
		"truncated": inspection.truncated,
	}


func _resource_inspect(args: Dictionary) -> Dictionary:
	var raw_path := str(args.get("path", "")).strip_edges()
	var normalized := _normalize_resource_path(raw_path)
	if not bool(normalized.get("ok", false)):
		return normalized
	var resource_path := str(normalized.path)
	if not ResourceLoader.exists(resource_path):
		return _error("Resource does not exist or is not recognized: %s" % resource_path)
	var resource := ResourceLoader.load(resource_path)
	if resource == null:
		return _error("Resource could not be loaded: %s" % resource_path)
	var inspection := _inspect_object_properties(resource, null, args)
	var include_dependencies := bool(args.get("include_dependencies", true))
	var dependency_limit := _bounded_int(
		args.get("dependency_limit"),
		DEFAULT_DEPENDENCY_LIMIT,
		1,
		MAX_DEPENDENCY_LIMIT
	)
	var raw_dependencies := (
		ResourceLoader.get_dependencies(resource_path)
		if include_dependencies
		else PackedStringArray()
	)
	var dependencies: Array = []
	for raw_dependency in raw_dependencies:
		if dependencies.size() >= dependency_limit:
			break
		dependencies.append(_dependency_summary(str(raw_dependency)))
	var uid := ResourceLoader.get_resource_uid(resource_path)
	return {
		"ok": true,
		"path": resource_path,
		"uid": ResourceUID.id_to_text(uid) if uid >= 0 else "",
		"resource_type": resource.get_class(),
		"resource_name": _limited_string(str(resource.resource_name), 512),
		"dependencies": dependencies,
		"dependency_count": raw_dependencies.size(),
		"dependencies_truncated": raw_dependencies.size() > dependencies.size(),
		"dependencies_included": include_dependencies,
		"properties": inspection.properties,
		"property_count": inspection.property_count,
		"property_list_count": inspection.property_list_count,
		"properties_scanned": inspection.properties_scanned,
		"properties_truncated": inspection.truncated,
		"serialization_truncated": inspection.serialization_truncated,
	}


func _edited_scene_root() -> Node:
	if editor_interface == null:
		return null
	return editor_interface.get_edited_scene_root()


func _scene_revision(scene_root: Node) -> String:
	if scene_root == null or not is_instance_valid(scene_root):
		return ""
	if editor_interface == null:
		# Direct serializer tests have no host editor; execute() cannot reach this branch.
		return EditorSceneMutator.scene_revision_for(scene_root, null)
	var undo_redo: EditorUndoRedoManager = editor_undo_redo
	if undo_redo == null:
		undo_redo = EditorInterface.get_editor_undo_redo()
	if undo_redo == null:
		return ""
	return EditorSceneMutator.scene_revision_for(scene_root, undo_redo)


static func _scene_id(scene_root: Node) -> String:
	if scene_root == null or not is_instance_valid(scene_root):
		return ""
	return "scene_%s" % str(scene_root.get_instance_id())


func _resolve_scene_node(scene_root: Node, raw_path: String) -> Dictionary:
	var path := raw_path.replace("\\", "/").strip_edges()
	if path.length() > MAX_NODE_PATH_LENGTH:
		return _error("Node path exceeds the %d character limit" % MAX_NODE_PATH_LENGTH)
	if path.is_empty() or path == ".":
		return {"ok": true, "node": scene_root}
	if path.begins_with("/") or path.contains(":") or path.contains("%"):
		return _error("Node path must be relative to the current scene root")
	for segment in path.split("/", true):
		if segment == ".." or segment == "." or segment.is_empty():
			return _error("Node path contains an invalid segment: %s" % raw_path)
	var node := scene_root.get_node_or_null(NodePath(path))
	if node == null:
		return _error("Node does not exist in the current scene: %s" % raw_path)
	if node != scene_root and not scene_root.is_ancestor_of(node):
		return _error("Node is outside the current scene root")
	return {"ok": true, "node": node}


func _build_node_tree(
	node: Node,
	scene_root: Node,
	depth: int,
	max_depth: int,
	max_nodes: int,
	include_internal: bool,
	state: Dictionary
) -> Variant:
	if int(state.count) >= max_nodes:
		state["truncated"] = true
		return null
	state["count"] = int(state.count) + 1
	var entry := _node_summary(node, scene_root)
	var children: Array = []
	var node_children := node.get_children(include_internal)
	if depth < max_depth:
		for child in node_children:
			if int(state.count) >= max_nodes:
				state["truncated"] = true
				break
			if child is Node:
				var child_entry = _build_node_tree(
					child,
					scene_root,
					depth + 1,
					max_depth,
					max_nodes,
					include_internal,
					state
				)
				if child_entry != null:
					children.append(child_entry)
	elif not node_children.is_empty():
		state["truncated"] = true
	entry["children"] = children
	entry["child_count"] = node_children.size()
	entry["children_truncated"] = children.size() < node_children.size()
	return entry


func _node_summary(node: Node, scene_root: Node) -> Dictionary:
	var relative_path := ""
	var in_current_scene := false
	if scene_root != null and is_instance_valid(scene_root):
		if node == scene_root:
			relative_path = "."
			in_current_scene = true
		elif scene_root.is_ancestor_of(node):
			relative_path = str(scene_root.get_path_to(node))
			in_current_scene = true
	var groups: Array[String] = []
	for raw_group in node.get_groups():
		var group := str(raw_group)
		if not group.begins_with("_") and groups.size() < MAX_GROUPS:
			groups.append(_limited_string(group, 128))
	var summary := {
		"name": _limited_string(str(node.name), 512),
		"type": node.get_class(),
		"path": _limited_string(relative_path, MAX_NODE_PATH_LENGTH),
		"in_current_scene": in_current_scene,
		"instance_id": str(node.get_instance_id()),
		"groups": groups,
	}
	var script_value = node.get_script()
	if script_value is Script:
		summary["script"] = _resource_reference(script_value)
	if node.owner != null and scene_root != null:
		if node.owner == scene_root:
			summary["owner_path"] = "."
		elif scene_root.is_ancestor_of(node.owner):
			summary["owner_path"] = _limited_string(str(scene_root.get_path_to(node.owner)), MAX_NODE_PATH_LENGTH)
	return summary


func _inspect_object_properties(object: Object, scene_root: Node, args: Dictionary) -> Dictionary:
	var limit_value = args.get("max_properties", args.get("limit"))
	var limit := _bounded_int(limit_value, DEFAULT_PROPERTY_LIMIT, 1, MAX_PROPERTY_LIMIT)
	var include_storage := bool(args.get("include_storage", false))
	var requested_names: Dictionary = {}
	var requested_value = args.get("property_names", [])
	if requested_value is Array or requested_value is PackedStringArray:
		for requested_name in requested_value:
			var name := str(requested_name)
			if not name.is_empty() and name.length() <= 256 and requested_names.size() < MAX_PROPERTY_LIMIT:
				requested_names[name] = true
	var properties: Array = []
	var eligible_count := 0
	var scanned_count := 0
	var truncated := false
	var serialization_budget := _new_serialization_budget()
	var property_list := object.get_property_list()
	for raw_info in property_list:
		if scanned_count >= MAX_PROPERTY_SCAN or _serialization_budget_exhausted(serialization_budget):
			truncated = true
			if _serialization_budget_exhausted(serialization_budget):
				serialization_budget["truncated"] = true
			break
		scanned_count += 1
		if not raw_info is Dictionary:
			continue
		var info: Dictionary = raw_info
		var name := str(info.get("name", ""))
		var usage := int(info.get("usage", 0))
		if not _property_is_visible(name, usage, include_storage):
			continue
		if not requested_names.is_empty() and not requested_names.has(name):
			continue
		eligible_count += 1
		if properties.size() >= limit:
			truncated = true
			break
		var type_id := int(info.get("type", TYPE_NIL))
		properties.append({
			"name": _limited_string(name, 256),
			"type": type_id,
			"type_name": type_string(type_id) if type_id >= TYPE_NIL and type_id < TYPE_MAX else "Unknown",
			"class_name": _limited_string(str(info.get("class_name", "")), 256),
			"usage": usage,
			"hint": int(info.get("hint", PROPERTY_HINT_NONE)),
			"hint_string": _limited_string(str(info.get("hint_string", "")), 1024),
			"value": _serialize_inspected_property(
				object.get(StringName(name)),
				object,
				scene_root,
				serialization_budget,
				info
			),
		})
		if not requested_names.is_empty() and properties.size() >= requested_names.size():
			break
	return {
		"properties": properties,
		"property_count": eligible_count,
		"property_list_count": property_list.size(),
		"properties_scanned": scanned_count,
		"serialization_truncated": bool(serialization_budget.get("truncated", false)),
		"truncated": (
			truncated
			or eligible_count > properties.size()
			or bool(serialization_budget.get("truncated", false))
		),
	}


static func _property_is_visible(name: String, usage: int, include_storage: bool) -> bool:
	if name.is_empty() or name.begins_with("_"):
		return false
	var structural_flags := PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP
	if (usage & structural_flags) != 0 or (usage & PROPERTY_USAGE_INTERNAL) != 0:
		return false
	if (usage & PROPERTY_USAGE_EDITOR) != 0:
		return true
	return include_storage and (usage & PROPERTY_USAGE_STORAGE) != 0


static func _serialize_inspected_property(
	value: Variant,
	property_owner: Object,
	scene_root: Node,
	budget: Dictionary,
	property_info: Dictionary = {}
) -> Variant:
	if value is NodePath and property_owner is Node:
		return _serialize_node_path_reference(value, property_owner, scene_root, budget)
	if value is Resource:
		return _serialize_resource_reference(
			value,
			budget,
			_expected_resource_type(value, property_info)
		)
	return _serialize_variant(value, scene_root, 0, budget)


static func _serialize_node_path_reference(
	value: NodePath,
	property_owner: Node,
	scene_root: Node,
	budget: Dictionary
) -> Dictionary:
	var raw_path := str(value)
	if raw_path.is_empty():
		return {"godot_type": "NodePath", "path": ""}
	if scene_root != null and is_instance_valid(scene_root):
		var target := property_owner.get_node_or_null(value)
		if target != null and (target == scene_root or scene_root.is_ancestor_of(target)):
			var root_path := "." if target == scene_root else str(scene_root.get_path_to(target))
			return {
				"godot_type": "NodePath",
				"path": _serialize_limited_string(root_path, MAX_NODE_PATH_LENGTH, budget),
			}
	return {
		"godot_type": "NodePath",
		"path": "",
		"stored_path": _serialize_limited_string(raw_path, MAX_NODE_PATH_LENGTH, budget),
		"unresolved": true,
	}


static func serialize_variant(value: Variant, scene_root: Node = null, depth: int = 0) -> Variant:
	return _serialize_variant(value, scene_root, depth, _new_serialization_budget())


static func _serialize_variant(
	value: Variant,
	scene_root: Node,
	depth: int,
	budget: Dictionary
) -> Variant:
	if _serialization_budget_exhausted(budget):
		budget["exhausted"] = true
		budget["truncated"] = true
		return {"godot_type": type_string(typeof(value)), "summary": "<value budget exhausted>"}
	budget["remaining_values"] = int(budget.remaining_values) - 1
	if depth > MAX_SERIALIZE_DEPTH:
		budget["truncated"] = true
		return {"godot_type": type_string(typeof(value)), "summary": "<depth limit>"}
	match typeof(value):
		TYPE_NIL:
			return null
		TYPE_BOOL:
			return value
		TYPE_INT:
			var integer := int(value)
			if integer < -JSON_SAFE_INTEGER_MAX or integer > JSON_SAFE_INTEGER_MAX:
				return {"godot_type": "int64", "value": str(integer)}
			return integer
		TYPE_FLOAT:
			return _json_float(float(value))
		TYPE_STRING, TYPE_STRING_NAME:
			return _serialize_string(str(value), budget)
		TYPE_NODE_PATH:
			return {
				"godot_type": "StoredNodePath",
				"stored_path": _serialize_limited_string(str(value), MAX_NODE_PATH_LENGTH, budget),
				"writable": false,
			}
		TYPE_VECTOR2:
			return {"godot_type": "Vector2", "x": _json_float(value.x), "y": _json_float(value.y)}
		TYPE_VECTOR2I:
			return {"godot_type": "Vector2i", "x": value.x, "y": value.y}
		TYPE_VECTOR3:
			return {
				"godot_type": "Vector3",
				"x": _json_float(value.x),
				"y": _json_float(value.y),
				"z": _json_float(value.z),
			}
		TYPE_VECTOR3I:
			return {"godot_type": "Vector3i", "x": value.x, "y": value.y, "z": value.z}
		TYPE_VECTOR4:
			return {
				"godot_type": "Vector4",
				"x": _json_float(value.x),
				"y": _json_float(value.y),
				"z": _json_float(value.z),
				"w": _json_float(value.w),
			}
		TYPE_VECTOR4I:
			return {"godot_type": "Vector4i", "x": value.x, "y": value.y, "z": value.z, "w": value.w}
		TYPE_COLOR:
			return {
				"godot_type": "Color",
				"r": _json_float(value.r),
				"g": _json_float(value.g),
				"b": _json_float(value.b),
				"a": _json_float(value.a),
			}
		TYPE_RECT2:
			return {
				"godot_type": "Rect2",
				"position": _serialize_variant(value.position, scene_root, depth + 1, budget),
				"size": _serialize_variant(value.size, scene_root, depth + 1, budget),
			}
		TYPE_RECT2I:
			return {
				"godot_type": "Rect2i",
				"position": _serialize_variant(value.position, scene_root, depth + 1, budget),
				"size": _serialize_variant(value.size, scene_root, depth + 1, budget),
			}
		TYPE_TRANSFORM2D:
			return {
				"godot_type": "Transform2D",
				"x": _serialize_variant(value.x, scene_root, depth + 1, budget),
				"y": _serialize_variant(value.y, scene_root, depth + 1, budget),
				"origin": _serialize_variant(value.origin, scene_root, depth + 1, budget),
			}
		TYPE_QUATERNION:
			return {
				"godot_type": "Quaternion",
				"x": _json_float(value.x),
				"y": _json_float(value.y),
				"z": _json_float(value.z),
				"w": _json_float(value.w),
			}
		TYPE_BASIS:
			return {
				"godot_type": "Basis",
				"x": _serialize_variant(value.x, scene_root, depth + 1, budget),
				"y": _serialize_variant(value.y, scene_root, depth + 1, budget),
				"z": _serialize_variant(value.z, scene_root, depth + 1, budget),
			}
		TYPE_TRANSFORM3D:
			return {
				"godot_type": "Transform3D",
				"basis": _serialize_variant(value.basis, scene_root, depth + 1, budget),
				"origin": _serialize_variant(value.origin, scene_root, depth + 1, budget),
			}
		TYPE_AABB:
			return {
				"godot_type": "AABB",
				"position": _serialize_variant(value.position, scene_root, depth + 1, budget),
				"size": _serialize_variant(value.size, scene_root, depth + 1, budget),
			}
		TYPE_PLANE:
			return {
				"godot_type": "Plane",
				"normal": _serialize_variant(value.normal, scene_root, depth + 1, budget),
				"d": _json_float(value.d),
			}
		TYPE_PROJECTION:
			return {
				"godot_type": "Projection",
				"x": _serialize_variant(value.x, scene_root, depth + 1, budget),
				"y": _serialize_variant(value.y, scene_root, depth + 1, budget),
				"z": _serialize_variant(value.z, scene_root, depth + 1, budget),
				"w": _serialize_variant(value.w, scene_root, depth + 1, budget),
			}
		TYPE_ARRAY:
			return _serialize_collection(value, scene_root, depth, budget)
		TYPE_DICTIONARY:
			return _serialize_dictionary(value, scene_root, depth, budget)
		TYPE_OBJECT:
			return _serialize_object(value, scene_root, budget)
		_:
			if _is_packed_array(value):
				return _serialize_collection(value, scene_root, depth, budget)
			return {
				"godot_type": type_string(typeof(value)),
				"summary": _serialize_string(str(value), budget),
			}


static func _serialize_collection(
	value: Variant,
	scene_root: Node,
	depth: int,
	budget: Dictionary
) -> Dictionary:
	var items: Array = []
	var total_size := int(value.size())
	var limit := mini(total_size, MAX_COLLECTION_ITEMS)
	for index in range(limit):
		if _serialization_budget_exhausted(budget):
			break
		items.append(_serialize_variant(value[index], scene_root, depth + 1, budget))
	var truncated := items.size() < total_size
	if truncated:
		budget["truncated"] = true
	return {
		"godot_type": type_string(typeof(value)),
		"size": total_size,
		"items": items,
		"truncated": truncated,
	}


static func _serialize_dictionary(
	value: Dictionary,
	scene_root: Node,
	depth: int,
	budget: Dictionary
) -> Dictionary:
	var entries: Array = []
	for raw_key in value:
		if entries.size() >= MAX_COLLECTION_ITEMS or _serialization_budget_exhausted(budget):
			break
		entries.append({
			"key": _serialize_variant(raw_key, scene_root, depth + 1, budget),
			"value": _serialize_variant(value[raw_key], scene_root, depth + 1, budget),
		})
	var truncated := entries.size() < value.size()
	if truncated:
		budget["truncated"] = true
	return {
		"godot_type": "Dictionary",
		"size": value.size(),
		"entries": entries,
		"truncated": truncated,
	}


static func _new_serialization_budget() -> Dictionary:
	return {
		"remaining_values": MAX_SERIALIZED_VALUES,
		"remaining_string_chars": MAX_SERIALIZED_STRING_CHARS,
		"exhausted": false,
		"truncated": false,
	}


static func _serialization_budget_exhausted(budget: Dictionary) -> bool:
	return int(budget.get("remaining_values", 0)) <= 0


static func _serialize_string(value: String, budget: Dictionary) -> String:
	var remaining := int(budget.get("remaining_string_chars", 0))
	if remaining <= 0:
		budget["truncated"] = true
		return "<string budget exhausted>"
	var allowed := mini(MAX_STRING_LENGTH, remaining)
	var consumed := mini(value.length(), allowed)
	budget["remaining_string_chars"] = remaining - consumed
	if value.length() <= allowed:
		return value
	budget["truncated"] = true
	var marker := "... <truncated>"
	if allowed <= marker.length():
		return value.left(allowed)
	return "%s%s" % [value.left(allowed - marker.length()), marker]


static func _serialize_limited_string(value: String, maximum: int, budget: Dictionary) -> String:
	if value.length() > maximum:
		budget["truncated"] = true
	return _serialize_string(_limited_string(value, maximum), budget)


static func _json_float(value: float) -> Variant:
	if not is_nan(value) and not is_inf(value):
		return value
	return {"godot_type": "float", "value": str(value)}


static func _serialize_object(value: Object, scene_root: Node, budget: Dictionary) -> Dictionary:
	if not is_instance_valid(value):
		return {"godot_type": "Object", "valid": false}
	if value is Resource:
		return _serialize_resource_reference(value, budget)
	if value is Node:
		var path := ""
		if scene_root != null and is_instance_valid(scene_root):
			if value == scene_root:
				path = "."
			elif scene_root.is_ancestor_of(value):
				path = str(scene_root.get_path_to(value))
		return {
			"godot_type": "Node",
			"type": _serialize_string(value.get_class(), budget),
			"path": _serialize_limited_string(path, MAX_NODE_PATH_LENGTH, budget),
			"instance_id": _serialize_string(str(value.get_instance_id()), budget),
		}
	return {
		"godot_type": "Object",
		"type": _serialize_string(value.get_class(), budget),
		"instance_id": _serialize_string(str(value.get_instance_id()), budget),
	}


static func _serialize_resource_reference(
	resource: Resource,
	budget: Dictionary,
	expected_type: String = ""
) -> Dictionary:
	var normalized_expected_type := expected_type if not expected_type.is_empty() else resource.get_class()
	var result := {
		"godot_type": "Resource",
		"resource_type": _serialize_string(resource.get_class(), budget),
		"expected_type": _serialize_string(normalized_expected_type, budget),
		"path": _serialize_limited_string(resource.resource_path, MAX_RESOURCE_PATH_LENGTH, budget),
		"name": _serialize_limited_string(str(resource.resource_name), 512, budget),
	}
	if not resource.resource_path.is_empty() and ResourceLoader.exists(resource.resource_path):
		var uid := ResourceLoader.get_resource_uid(resource.resource_path)
		if uid >= 0:
			result["uid"] = _serialize_string(ResourceUID.id_to_text(uid), budget)
	return result


static func _expected_resource_type(resource: Resource, property_info: Dictionary) -> String:
	var candidates := PackedStringArray()
	var class_name_value := str(property_info.get("class_name", "")).strip_edges()
	if not class_name_value.is_empty():
		candidates.append(class_name_value)
	if int(property_info.get("hint", PROPERTY_HINT_NONE)) == PROPERTY_HINT_RESOURCE_TYPE:
		for raw_type in str(property_info.get("hint_string", "")).split(",", false):
			var type_name := raw_type.strip_edges()
			if not type_name.is_empty() and not candidates.has(type_name):
				candidates.append(type_name)
	for candidate in candidates:
		if resource.is_class(candidate):
			return candidate
	return resource.get_class()


static func _resource_reference(resource: Resource) -> Dictionary:
	var result := {
		"godot_type": "Resource",
		"resource_type": resource.get_class(),
		"expected_type": resource.get_class(),
		"path": _limited_string(resource.resource_path, MAX_RESOURCE_PATH_LENGTH),
		"name": _limited_string(str(resource.resource_name), 512),
	}
	if not resource.resource_path.is_empty() and ResourceLoader.exists(resource.resource_path):
		var uid := ResourceLoader.get_resource_uid(resource.resource_path)
		if uid >= 0:
			result["uid"] = ResourceUID.id_to_text(uid)
	return result


static func _is_packed_array(value: Variant) -> bool:
	return (
		value is PackedByteArray
		or value is PackedInt32Array
		or value is PackedInt64Array
		or value is PackedFloat32Array
		or value is PackedFloat64Array
		or value is PackedStringArray
		or value is PackedVector2Array
		or value is PackedVector3Array
		or value is PackedColorArray
		or value is PackedVector4Array
	)


static func _normalize_resource_path(raw_path: String) -> Dictionary:
	var path := raw_path.replace("\\", "/").strip_edges()
	if path.is_empty():
		return _error("Resource path is required")
	if path.length() > MAX_RESOURCE_PATH_LENGTH:
		return _error("Resource path exceeds the %d character limit" % MAX_RESOURCE_PATH_LENGTH)
	if path.begins_with("res://"):
		path = path.trim_prefix("res://")
	elif path.begins_with("user://") or path.begins_with("/") or path.contains(":"):
		return _error("Resource path must be inside res://")
	var segments := path.split("/", true)
	var clean_segments := PackedStringArray()
	for segment in segments:
		if segment == ".." or segment == "." or segment.is_empty():
			return _error("Resource path contains an invalid segment: %s" % raw_path)
		clean_segments.append(segment)
	if clean_segments.is_empty():
		return _error("Resource path is required")
	return {"ok": true, "path": "res://%s" % "/".join(clean_segments)}


static func _dependency_summary(raw_dependency: String) -> Dictionary:
	var result := {"raw": _limited_string(raw_dependency), "uid": "", "path": ""}
	if raw_dependency.contains("::"):
		result["uid"] = _limited_string(raw_dependency.get_slice("::", 0), 256)
		result["path"] = _limited_string(raw_dependency.get_slice("::", 2), MAX_RESOURCE_PATH_LENGTH)
	else:
		result["path"] = _limited_string(raw_dependency, MAX_RESOURCE_PATH_LENGTH)
	return result


static func _bounded_int(value: Variant, fallback: int, minimum: int, maximum: int) -> int:
	if value is int or value is float:
		return clampi(int(value), minimum, maximum)
	return fallback


static func _bounded_json_integer(value: Variant, minimum: int, maximum: int) -> Dictionary:
	if value is bool:
		return {"ok": false}
	if value is int:
		var integer_value := int(value)
		if integer_value < minimum or integer_value > maximum:
			return {"ok": false}
		return {"ok": true, "value": integer_value}
	if not value is float:
		return {"ok": false}
	var float_value := float(value)
	if is_nan(float_value) or is_inf(float_value) or float_value != floor(float_value):
		return {"ok": false}
	if float_value < float(minimum) or float_value > float(maximum):
		return {"ok": false}
	return {"ok": true, "value": int(float_value)}


static func _limited_string(value: String, maximum: int = MAX_STRING_LENGTH) -> String:
	var limit := maxi(0, maximum)
	if value.length() <= limit:
		return value
	var marker := "... <truncated>"
	if limit <= marker.length():
		return value.left(limit)
	return "%s%s" % [value.left(limit - marker.length()), marker]


static func _error(message: String) -> Dictionary:
	return {"ok": false, "error": message}
