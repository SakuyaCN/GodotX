extends SceneTree

const EditorBridge := preload("res://addons/godetx/editor_bridge.gd")

var _failures := PackedStringArray()


class FakeGameDebugger:
	extends RefCounted

	var snapshot_limit := 0
	var stop_calls := 0
	var automation_run_calls := 0
	var automation_status_calls := 0
	var automation_cancel_calls := 0
	var automation_run_id := ""
	var automation_id := ""
	var automation_steps: Array = []
	var automation_stop_on_failure := false
	var screenshot_calls := 0
	var screenshot_cancel_calls := 0
	var screenshot_run_id := ""
	var screenshot_max_dimension := 0
	var screenshot_callback := Callable()


	func snapshot(history_limit: int = 100, _after_seq: int = 0) -> Dictionary:
		snapshot_limit = history_limit
		return {"ok": true, "history_limit": history_limit, "owned": false}


	func stop_owned(_expected_run_id: String = "") -> Dictionary:
		stop_calls += 1
		return {"ok": false, "error": "No owned run"}


	func automation_run(run_id: String, steps: Array, stop_on_failure: bool) -> Dictionary:
		automation_run_calls += 1
		automation_run_id = run_id
		automation_steps = steps.duplicate(true)
		automation_stop_on_failure = stop_on_failure
		return {
			"ok": true,
			"automation_id": "automation_test",
			"run_id": run_id,
			"state": "queued",
			"step_count": steps.size(),
		}


	func automation_status(run_id: String, requested_automation_id: String) -> Dictionary:
		automation_status_calls += 1
		automation_run_id = run_id
		automation_id = requested_automation_id
		return {
			"ok": true,
			"automation_id": requested_automation_id,
			"run_id": run_id,
			"state": "running",
		}


	func automation_cancel(run_id: String, requested_automation_id: String) -> Dictionary:
		automation_cancel_calls += 1
		automation_run_id = run_id
		automation_id = requested_automation_id
		return {
			"ok": true,
			"automation_id": requested_automation_id,
			"run_id": run_id,
			"state": "cancelled",
		}


	func capture_screenshot(run_id: String, max_dimension: int, completed: Callable) -> Dictionary:
		screenshot_calls += 1
		screenshot_run_id = run_id
		screenshot_max_dimension = max_dimension
		screenshot_callback = completed
		return {
			"ok": true,
			"pending": true,
			"run_id": run_id,
			"capture_id": "capture_0123456789abcdef",
		}


	func cancel_screenshot(capture_id: String, _reason: String) -> bool:
		if capture_id != "capture_0123456789abcdef":
			return false
		screenshot_cancel_calls += 1
		return true


func _init() -> void:
	var bridge := EditorBridge.new()
	var unavailable := bridge.execute("scene_get_tree", {})
	_assert(not bool(unavailable.get("ok", true)), "Scene tools should fail safely without EditorInterface")
	var write_unavailable := bridge.execute("scene_apply_operations", {})
	_assert(not bool(write_unavailable.get("ok", true)), "Live scene writes should route through the EditorBridge")
	var unknown := bridge.execute("unknown_tool", {})
	_assert(not bool(unknown.get("ok", true)), "Unknown tools should return a structured error")
	var api_search: Dictionary = bridge.execute("godot_api_query", {
		"action": "search",
		"query": "Node2D",
		"limit": 16,
	})
	var api_classes_value: Variant = api_search.get("classes", [])
	var api_classes: Array = api_classes_value if api_classes_value is Array else []
	_assert(
		bool(api_search.get("ok", false))
		and _array_has_named_entry(api_classes, "Node2D"),
		"Godot API search should query the running editor ClassDB without a scene lease"
	)
	var api_description: Dictionary = bridge.execute("godot_api_query", {
		"action": "describe",
		"class_name": "Node2D",
		"member_query": "position",
		"include_inherited": true,
		"limit": 32,
	})
	var api_properties_value: Variant = api_description.get("properties", [])
	var api_properties: Array = api_properties_value if api_properties_value is Array else []
	_assert(
		bool(api_description.get("ok", false))
		and _array_has_named_entry(api_properties, "position"),
		"Godot API descriptions should expose bounded live property metadata"
	)
	var invalid_api_query: Dictionary = bridge.execute("godot_api_query", {
		"action": "describe",
		"class_name": "../Node",
	})
	_assert(
		not bool(invalid_api_query.get("ok", true)),
		"Godot API queries should reject unsafe class identifiers"
	)
	var debug_unavailable: Dictionary = bridge.execute("game_debug_status", {})
	_assert(not bool(debug_unavailable.get("ok", true)), "Game debugging should fail safely without a debugger")
	var fake_debugger = FakeGameDebugger.new()
	var debug_bridge = EditorBridge.new(null, null, fake_debugger, false)
	var debug_status: Dictionary = debug_bridge.execute("game_debug_status", {"history_limit": 27})
	_assert(bool(debug_status.get("ok", false)), "Game debug status should route without a scene lease")
	_assert(fake_debugger.snapshot_limit == 27, "Game debug status should forward the bounded history limit")
	var debug_stop: Dictionary = debug_bridge.execute("game_debug_stop", {
		"run_id": "0123456789abcdef0123456789abcdef",
	})
	_assert(not bool(debug_stop.get("ok", true)), "Game debug stop should preserve ownership failures")
	_assert(fake_debugger.stop_calls == 1, "Game debug stop should route exactly once")
	var debug_start: Dictionary = debug_bridge.execute("game_debug_start", {"mode": "main"})
	_assert(not bool(debug_start.get("ok", true)), "Game debug start should require a live EditorInterface")
	var screenshot_callback := func(_result: Dictionary) -> void:
		pass
	for json_dimension in [1600.0, 1280.0, 1024.0]:
		var normalized_dimension: Dictionary = EditorBridge._bounded_json_integer(
			json_dimension,
			64,
			2048
		)
		_assert(
			bool(normalized_dimension.get("ok", false))
			and typeof(normalized_dimension.get("value")) == TYPE_INT
			and int(normalized_dimension.get("value", 0)) == int(json_dimension),
			"Integral screenshot JSON floats should normalize without truncation"
		)
	var screenshot_request: Dictionary = debug_bridge.execute_deferred(
		"game_capture_screenshot",
		{
			"run_id": "0123456789abcdef0123456789abcdef",
			"max_dimension": 1280.0,
		},
		screenshot_callback
	)
	_assert(
		bool(screenshot_request.get("pending", false))
		and fake_debugger.screenshot_calls == 1
		and fake_debugger.screenshot_run_id == "0123456789abcdef0123456789abcdef"
		and fake_debugger.screenshot_max_dimension == 1280
		and fake_debugger.screenshot_callback == screenshot_callback,
		"Deferred game screenshots should preserve run identity, dimensions, and completion"
	)
	_assert(
		debug_bridge.cancel_deferred(
			"game_capture_screenshot",
			str(screenshot_request.get("capture_id", "")),
			"test timeout"
		)
		and fake_debugger.screenshot_cancel_calls == 1,
		"Deferred game screenshots should cancel by their exact capture ID"
	)
	var invalid_screenshot: Dictionary = debug_bridge.execute_deferred(
		"game_capture_screenshot",
		{"run_id": "0123456789abcdef0123456789abcdef", "max_dimension": 4096},
		screenshot_callback
	)
	_assert(
		not bool(invalid_screenshot.get("ok", true)) and fake_debugger.screenshot_calls == 1,
		"Invalid screenshot dimensions should be rejected before debugger routing"
	)
	var fractional_screenshot: Dictionary = debug_bridge.execute_deferred(
		"game_capture_screenshot",
		{"run_id": "0123456789abcdef0123456789abcdef", "max_dimension": 1280.5},
		screenshot_callback
	)
	var non_finite_screenshot: Dictionary = debug_bridge.execute_deferred(
		"game_capture_screenshot",
		{"run_id": "0123456789abcdef0123456789abcdef", "max_dimension": INF},
		screenshot_callback
	)
	_assert(
		not bool(fractional_screenshot.get("ok", true))
		and not bool(non_finite_screenshot.get("ok", true))
		and fake_debugger.screenshot_calls == 1,
		"Screenshot dimensions must reject fractional and non-finite JSON numbers"
	)

	var run_id := "0123456789abcdef0123456789abcdef"
	var automation_id := "automation_0123456789abcdef"
	var disabled_run: Dictionary = debug_bridge.execute("game_automation_run", {
		"run_id": run_id,
		"steps": [{"type": "wait_frames", "frames": 2}],
	})
	_assert(
		not bool(disabled_run.get("ok", true))
		and str(disabled_run.get("error", "")).contains("disabled"),
		"Runtime automation runs should be rejected while the setting is disabled"
	)
	var disabled_cancel: Dictionary = debug_bridge.execute("game_automation_cancel", {
		"run_id": run_id,
		"automation_id": automation_id,
	})
	_assert(
		not bool(disabled_cancel.get("ok", true))
		and fake_debugger.automation_run_calls == 0
		and fake_debugger.automation_cancel_calls == 0,
		"Disabled automation must reject run and cancel before reaching the debugger"
	)
	var disabled_status: Dictionary = debug_bridge.execute("game_automation_status", {
		"run_id": run_id,
		"automation_id": automation_id,
	})
	_assert(
		bool(disabled_status.get("ok", false))
		and str(disabled_status.get("state", "")) == "running"
		and fake_debugger.automation_status_calls == 1,
		"Automation status should remain available while new automation is disabled"
	)

	var automation_bridge = EditorBridge.new(null, null, fake_debugger, true)
	var enabled_steps := [
		{"type": "click_control", "node_path": "Menu/Start"},
		{"type": "assert_node", "node_path": "Board", "check": "exists"},
	]
	var enabled_run: Dictionary = automation_bridge.execute("game_automation_run", {
		"run_id": run_id,
		"steps": enabled_steps,
		"stop_on_failure": true,
	})
	var enabled_status: Dictionary = automation_bridge.execute("game_automation_status", {
		"run_id": run_id,
		"automation_id": automation_id,
	})
	var enabled_cancel: Dictionary = automation_bridge.execute("game_automation_cancel", {
		"run_id": run_id,
		"automation_id": automation_id,
	})
	_assert(
		bool(enabled_run.get("ok", false))
		and bool(enabled_status.get("ok", false))
		and bool(enabled_cancel.get("ok", false))
		and fake_debugger.automation_run_calls == 1
		and fake_debugger.automation_status_calls == 2
		and fake_debugger.automation_cancel_calls == 1,
		"An enabled bridge should route run, status, and cancel exactly once per request"
	)
	_assert(
		fake_debugger.automation_run_id == run_id
		and fake_debugger.automation_id == automation_id
		and fake_debugger.automation_steps == enabled_steps
		and fake_debugger.automation_stop_on_failure,
		"Automation routing should preserve ownership ids, steps, and stop-on-failure"
	)
	automation_bridge.set_runtime_automation_enabled(false)
	var disabled_after_update: Dictionary = automation_bridge.execute("game_automation_cancel", {
		"run_id": run_id,
		"automation_id": automation_id,
	})
	_assert(
		not bool(disabled_after_update.get("ok", true))
		and fake_debugger.automation_cancel_calls == 1,
		"Applying the setting at runtime should immediately close the mutation path"
	)

	var root := Node2D.new()
	root.name = "Main"
	var title := Label.new()
	title.name = "Title"
	title.text = "Hello"
	root.add_child(title)
	var nested := Node.new()
	nested.name = "Nested"
	title.add_child(nested)
	var sibling := Node.new()
	sibling.name = "Sibling"
	root.add_child(sibling)
	var scene_lease := bridge._capture_scene_lease_for_root(root)
	_assert(
		bool(bridge._validate_scene_lease_for_root(root, scene_lease).get("ok", false)),
		"A scene lease should validate only against its captured root"
	)
	var other_root := Node2D.new()
	other_root.name = "Other"
	var switched_scene := bridge._validate_scene_lease_for_root(other_root, scene_lease)
	_assert(
		not bool(switched_scene.get("ok", true))
		and str(switched_scene.get("error_code", "")) == "EDITOR_SCENE_CONTEXT_CHANGED",
		"A scene lease must reject a different root before reading or writing it"
	)
	var stale_lease := scene_lease.duplicate(true)
	stale_lease["scene_revision"] = "%s_stale" % str(scene_lease.get("scene_revision", ""))
	_assert(
		not bool(bridge._validate_scene_lease_for_root(root, stale_lease).get("ok", true)),
		"A scene lease must reject an externally changed revision"
	)
	var bound_tree := bridge.execute("scene_get_tree", {"max_depth": 0}, scene_lease)
	_assert(bool(bound_tree.get("ok", false)), "Bound scene reads should use the captured root")

	var tree_result := bridge._scene_get_tree_from_root(root, {"max_depth": 1, "max_nodes": 2})
	_assert(bool(tree_result.get("ok", false)), "Local scene tree inspection should succeed")
	_assert(str(tree_result.get("scene_id", "")).begins_with("scene_"), "Scene inspection should return an opaque scene id")
	_assert(not str(tree_result.get("scene_revision", "")).is_empty(), "Successful scene inspection must return a revision")
	_assert(int(tree_result.get("node_count", 0)) == 2, "Scene tree should honor max_nodes")
	_assert(bool(tree_result.get("truncated", false)), "Scene tree should report truncation")
	var tree: Dictionary = tree_result.get("tree", {})
	_assert(str(tree.get("path", "")) == ".", "Scene root path should be relative")
	var children_value = tree.get("children", [])
	var children: Array = children_value if children_value is Array else []
	_assert(not children.is_empty(), "Scene tree should include child nodes")
	if not children.is_empty() and children[0] is Dictionary:
		_assert(str(children[0].get("path", "")) == "Title", "Child path should be relative to scene root")

	var property_result := bridge._node_get_properties_from_root(root, {
		"node_path": "Title",
		"property_names": ["text"],
		"max_properties": 8,
	})
	_assert(bool(property_result.get("ok", false)), "Node property inspection should succeed")
	var properties_value = property_result.get("properties", [])
	var properties: Array = properties_value if properties_value is Array else []
	_assert(properties.size() == 1, "Property name filtering should limit the result")
	if properties.size() == 1 and properties[0] is Dictionary:
		_assert(str(properties[0].get("name", "")) == "text", "Text property should be returned")
		_assert(str(properties[0].get("value", "")) == "Hello", "Property value should be serialized")
	var icon := TextureRect.new()
	icon.name = "Icon"
	icon.texture = ResourceLoader.load("res://addons/godetx/icons/godotx-mark.png") as Texture2D
	root.add_child(icon)
	var texture_result := bridge._node_get_properties_from_root(root, {
		"node_path": "Icon",
		"property_names": ["texture"],
		"max_properties": 4,
	})
	var texture_properties_value = texture_result.get("properties", [])
	var texture_properties: Array = texture_properties_value if texture_properties_value is Array else []
	if texture_properties.size() == 1 and texture_properties[0] is Dictionary:
		var texture_value = texture_properties[0].get("value", {})
		_assert(texture_value is Dictionary, "Resource properties should use a tagged value")
		if texture_value is Dictionary:
			_assert(str(texture_value.get("expected_type", "")) == "Texture2D", "Resource tags should preserve the property's assignable type")
			_assert(not str(texture_value.get("resource_type", "")).is_empty(), "Resource tags should include the concrete loaded type")
	var stale_result := bridge._node_get_properties_from_root(root, {
		"scene_id": "scene_stale",
		"node_path": "Title",
	})
	_assert(not bool(stale_result.get("ok", true)), "Stale scene ids should be rejected")

	var color_value: Dictionary = bridge.serialize_variant(Color(0.25, 0.5, 0.75, 1.0))
	_assert(color_value.get("godot_type") == "Color", "Color should use a tagged JSON-safe value")
	var vector_value: Dictionary = bridge.serialize_variant(Vector3(1, 2, 3))
	_assert(vector_value == {"godot_type": "Vector3", "x": 1.0, "y": 2.0, "z": 3.0}, "Vector3 encoding is invalid")
	var vector4_value: Dictionary = bridge.serialize_variant(Vector4(1, 2, 3, 4))
	_assert(vector4_value == {"godot_type": "Vector4", "x": 1.0, "y": 2.0, "z": 3.0, "w": 4.0}, "Vector4 encoding is invalid")
	var vector4i_value: Dictionary = bridge.serialize_variant(Vector4i(-1, 0, 1, 2))
	_assert(vector4i_value == {"godot_type": "Vector4i", "x": -1, "y": 0, "z": 1, "w": 2}, "Vector4i encoding is invalid")
	var node_path_value: Dictionary = bridge._serialize_node_path_reference(NodePath("../Sibling"), title, root, bridge._new_serialization_budget())
	_assert(node_path_value == {"godot_type": "NodePath", "path": "Sibling"}, "NodePath reads should be scene-root-relative")
	var stored_node_path: Dictionary = bridge.serialize_variant(NodePath("../Sibling"))
	_assert(stored_node_path.get("godot_type") == "StoredNodePath", "Ownerless NodePaths must not look writable")
	var object_value: Dictionary = bridge.serialize_variant(title, root)
	_assert(object_value.get("path") == "Title", "Node references should use relative scene paths")
	var unsafe_integer: Dictionary = bridge.serialize_variant(9_007_199_254_740_992)
	_assert(unsafe_integer.get("godot_type") == "int64", "Unsafe JSON integers should use tagged strings")
	_assert(unsafe_integer.get("value") == "9007199254740992", "Tagged int64 values should retain precision")
	var mixed_dictionary: Dictionary = bridge.serialize_variant({1: "integer key", "1": "string key"})
	var dictionary_entries_value = mixed_dictionary.get("entries", [])
	var dictionary_entries: Array = dictionary_entries_value if dictionary_entries_value is Array else []
	_assert(dictionary_entries.size() == 2, "Dictionary key types should not collide during serialization")
	var repeated_child := range(64)
	var nested_collection: Array = []
	for _index in range(64):
		nested_collection.append(repeated_child)
	var nested_value: Dictionary = bridge.serialize_variant(nested_collection)
	_assert(bool(nested_value.get("truncated", false)), "Nested collections should honor a shared value budget")
	_assert(not JSON.stringify({"color": color_value, "node": object_value}).is_empty(), "Serialized values must be JSON-safe")

	var safe_path := bridge._normalize_resource_path("demo/main.tscn")
	_assert(safe_path.get("path") == "res://demo/main.tscn", "Relative resource paths should be normalized")
	_assert(not bool(bridge._normalize_resource_path("../outside.tres").get("ok", true)), "Traversal paths must be rejected")
	_assert(not bool(bridge._normalize_resource_path("demo//main.tscn").get("ok", true)), "Empty path segments must be rejected")
	_assert(not bool(bridge._normalize_resource_path("C:/outside.tres").get("ok", true)), "Absolute paths must be rejected")
	_assert(
		bool(bridge._validated_game_scene_path("demo/main.tscn").get("ok", false)),
		"The demo PackedScene should be accepted as a game target"
	)
	_assert(
		not bool(bridge._validated_game_scene_path("addons/godetx/plugin.gd").get("ok", true)),
		"Non-scene resources must be rejected as game targets"
	)
	_assert(not bool(bridge._resolve_scene_node(root, "Title/%Nested").get("ok", true)), "Unique-name node jumps must be rejected")
	var resource_result := bridge.execute("resource_inspect", {
		"path": "res://demo/main.tscn",
		"max_properties": 16,
		"include_dependencies": false,
		"dependency_limit": 16,
	})
	_assert(bool(resource_result.get("ok", false)), "Project resource inspection should succeed")
	_assert(str(resource_result.get("resource_type", "")) == "PackedScene", "Scene resource type should be reported")
	var resource_uid := str(resource_result.get("uid", ""))
	_assert(resource_uid.is_empty() or resource_uid.begins_with("uid://"), "Resource UIDs should use Godot's public uid:// format")
	_assert(resource_result.get("dependencies", []) is Array, "Resource dependencies should be structured")
	_assert((resource_result.get("dependencies", []) as Array).is_empty(), "Dependency reads should be optional")

	other_root.free()
	root.free()
	if not _failures.is_empty():
		for failure in _failures:
			printerr(failure)
		quit(1)
		return
	print("GODETX_EDITOR_BRIDGE_OK")
	quit(0)


func _assert(condition: bool, message: String) -> void:
	if not condition:
		_failures.append(message)


func _array_has_named_entry(entries: Array, expected_name: String) -> bool:
	for entry_value in entries:
		if entry_value is Dictionary and str((entry_value as Dictionary).get("name", "")) == expected_name:
			return true
	return false
