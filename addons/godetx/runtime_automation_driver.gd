@tool
class_name GodetXRuntimeAutomationDriver
extends RefCounted

const PROTOCOL_VERSION := 1
const MAX_PLAN_BYTES := 64 * 1024
const MAX_STEPS := 64
const MAX_FRAME_BUDGET := 7200
const MAX_RESULT_TEXT_CHARS := 512
const MAX_NODE_PATH_CHARS := 512
const MAX_PROPERTY_NAME_CHARS := 256
const HEARTBEAT_INTERVAL_MS := 1000

var _tree: SceneTree
var _run_id: String = ""
var _event_sink: Callable
var _active: Dictionary = {}
var _step_state: Dictionary = {}
var _held_actions: Dictionary = {}
var _held_mouse: Dictionary = {}
var _next_heartbeat_at_ms: int = 0


func _init(tree: SceneTree = null, run_id: String = "", event_sink: Callable = Callable()) -> void:
	_tree = tree
	_run_id = run_id
	_event_sink = event_sink


static func validate_steps(value: Variant) -> Dictionary:
	if not value is Array:
		return _error_static("steps must be an array")
	var steps: Array = value
	if steps.is_empty():
		return _error_static("steps must contain at least one operation")
	if steps.size() > MAX_STEPS:
		return _error_static("steps must contain at most %d operations" % MAX_STEPS)
	if JSON.stringify(steps).to_utf8_buffer().size() > MAX_PLAN_BYTES:
		return _error_static("The automation plan exceeds the 64 KiB limit")

	var frame_budget: int = 0
	var clean_steps: Array[Dictionary] = []
	for index in range(steps.size()):
		var step_value: Variant = steps[index]
		if not step_value is Dictionary:
			return _error_static("steps[%d] must be an object" % index)
		var validation: Dictionary = _validate_step(step_value as Dictionary, index)
		if not bool(validation.get("ok", false)):
			return validation
		frame_budget += int(validation.get("frame_budget", 0))
		if frame_budget > MAX_FRAME_BUDGET:
			return _error_static(
				"The automation plan exceeds the %d-frame budget" % MAX_FRAME_BUDGET
			)
		clean_steps.append((validation.get("step", {}) as Dictionary).duplicate(true))
	return {
		"ok": true,
		"steps": clean_steps,
		"frame_budget": frame_budget,
	}


static func is_safe_identifier(value: String) -> bool:
	if value.length() < 16 or value.length() > 128:
		return false
	for index in range(value.length()):
		var character: int = value.unicode_at(index)
		var is_digit: bool = character >= 48 and character <= 57
		var is_upper: bool = character >= 65 and character <= 90
		var is_lower: bool = character >= 97 and character <= 122
		if not is_digit and not is_upper and not is_lower and character != 45 and character != 95:
			return false
	return true


static func is_safe_node_path(value: String) -> bool:
	if value.is_empty() or value.length() > MAX_NODE_PATH_CHARS:
		return false
	if value == ".":
		return true
	if value.begins_with("/") or value.ends_with("/") or value.contains("\\"):
		return false
	var segments: PackedStringArray = value.split("/", true)
	for segment in segments:
		if segment.is_empty() or segment == "." or segment == "..":
			return false
		if segment.strip_edges() != segment:
			return false
		for index in range(segment.length()):
			var character: int = segment.unicode_at(index)
			if (
				character < 32
				or character == 127
				or character == 34
				or character == 37
				or character == 46
				or character == 58
				or character == 64
				or character == 92
			):
				return false
	return true


func execute(envelope: Dictionary) -> void:
	var automation_id: String = str(envelope.get("automation_id", ""))
	var requested_steps: Variant = envelope.get("steps", [])
	var requested_step_count: int = 0
	if requested_steps is Array:
		requested_step_count = mini((requested_steps as Array).size(), MAX_STEPS)
	if not _active.is_empty():
		_emit_rejection(
			automation_id,
			"Another runtime automation plan is already active",
			requested_step_count
		)
		return
	var validation: Dictionary = validate_steps(requested_steps)
	if not bool(validation.get("ok", false)):
		_emit_rejection(
			automation_id,
			str(validation.get("error", "Invalid automation plan")),
			requested_step_count
		)
		return
	var clean_steps: Array = validation.get("steps", [])
	_active = {
		"automation_id": automation_id,
		"run_id": _run_id,
		"state": "running",
		"current_step": 0,
		"step_count": clean_steps.size(),
		"steps": clean_steps,
		"results": [],
		"failure": "",
		"had_failure": false,
		"stop_on_failure": bool(envelope.get("stop_on_failure", true)),
		"started_at_ms": Time.get_ticks_msec(),
		"ended_at_ms": 0,
	}
	_step_state.clear()
	_next_heartbeat_at_ms = Time.get_ticks_msec() + HEARTBEAT_INTERVAL_MS
	_emit_status()


func reject(automation_id: String, error: String, step_count: int = 0) -> void:
	_emit_rejection(automation_id, error, step_count)


func cancel(automation_id: String) -> bool:
	if _active.is_empty() or str(_active.get("automation_id", "")) != automation_id:
		return false
	_release_held_inputs()
	_finish_plan("cancelled", "Automation was cancelled")
	return true


func shutdown() -> void:
	if not _active.is_empty():
		_release_held_inputs()
	_active.clear()
	_step_state.clear()


func process_frame() -> void:
	if _active.is_empty():
		return
	if _tree == null:
		_fail_step("The running SceneTree is unavailable")
		return
	if int(_active.get("current_step", 0)) >= int(_active.get("step_count", 0)):
		_finish_completed_plan()
		return
	if _step_state.is_empty():
		_start_step()
	else:
		_advance_step()
	_emit_heartbeat_if_due()


func process_physics_frame() -> void:
	if _active.is_empty() or str(_step_state.get("phase", "")) != "action_hold":
		return
	var action_remaining: int = int(_step_state.get("remaining", 0)) - 1
	_step_state["remaining"] = action_remaining
	if action_remaining <= 0:
		var action: String = str(_step_state.get("action", ""))
		_send_action(action, false)
		_held_actions.erase(action)
		_pass_step("Input action released")


func has_active_plan() -> bool:
	return not _active.is_empty()


func active_automation_id() -> String:
	return str(_active.get("automation_id", ""))


static func _validate_step(step: Dictionary, index: int) -> Dictionary:
	var type_value: Variant = step.get("type")
	if not type_value is String or (type_value as String).is_empty():
		return _error_static("steps[%d].type is required" % index)
	var step_type: String = type_value
	match step_type:
		"wait_frames":
			var frames_value: Variant = step.get("frames")
			var frames_result: Dictionary = _bounded_integer(frames_value, 1, 3600)
			if not bool(frames_result.get("ok", false)):
				return _error_static("steps[%d].frames must be an integer from 1 to 3600" % index)
			var frames: int = int(frames_result.get("value", 0))
			return {
				"ok": true,
				"step": {"type": step_type, "frames": frames},
				"frame_budget": frames,
			}
		"click_control":
			var click_path_value: Variant = step.get("node_path")
			if not click_path_value is String or not is_safe_node_path(click_path_value as String):
				return _error_static("steps[%d].node_path must be a safe current-scene path" % index)
			var button_value: Variant = step.get("button", 1)
			var button_result: Dictionary = _bounded_integer(button_value, 1, 3)
			if not bool(button_result.get("ok", false)):
				return _error_static("steps[%d].button must be 1, 2, or 3" % index)
			var button: int = int(button_result.get("value", 0))
			return {
				"ok": true,
				"step": {
					"type": step_type,
					"node_path": click_path_value,
					"button": button,
				},
				"frame_budget": 0,
			}
		"press_action":
			var action_value: Variant = step.get("action")
			if not action_value is String or not _is_safe_action_name(action_value as String):
				return _error_static("steps[%d].action must be a non-empty InputMap action" % index)
			var pressed_value: Variant = step.get("pressed", true)
			if not pressed_value is bool:
				return _error_static("steps[%d].pressed must be boolean" % index)
			if not bool(pressed_value) and step.has("duration_frames"):
				return _error_static(
					"steps[%d].duration_frames is only valid when pressed is true" % index
				)
			var duration: int = 0
			if bool(pressed_value):
				var duration_value: Variant = step.get("duration_frames", 1)
				var duration_result: Dictionary = _bounded_integer(duration_value, 1, 600)
				if not bool(duration_result.get("ok", false)):
					return _error_static(
						"steps[%d].duration_frames must be an integer from 1 to 600" % index
					)
				duration = int(duration_result.get("value", 0))
			var clean_action: Dictionary = {
				"type": step_type,
				"action": action_value,
				"pressed": bool(pressed_value),
			}
			if bool(pressed_value):
				clean_action["duration_frames"] = duration
			return {
				"ok": true,
				"step": clean_action,
				"frame_budget": duration,
			}
		"assert_node":
			var assert_path_value: Variant = step.get("node_path")
			if not assert_path_value is String or not is_safe_node_path(assert_path_value as String):
				return _error_static("steps[%d].node_path must be a safe current-scene path" % index)
			var check_value: Variant = step.get("check")
			if not check_value is String:
				return _error_static("steps[%d].check is required" % index)
			var check: String = check_value
			if check != "exists" and check != "property_equals" and check != "property_contains":
				return _error_static("steps[%d].check is unsupported" % index)
			var timeout_value: Variant = step.get("timeout_frames", 0)
			var timeout_result: Dictionary = _bounded_integer(timeout_value, 0, 600)
			if not bool(timeout_result.get("ok", false)):
				return _error_static("steps[%d].timeout_frames must be an integer from 0 to 600" % index)
			var timeout: int = int(timeout_result.get("value", 0))
			var clean_assert: Dictionary = {
				"type": step_type,
				"node_path": assert_path_value,
				"check": check,
				"timeout_frames": timeout,
			}
			if check == "exists":
				var exists_value: Variant = step.get("exists", true)
				if not exists_value is bool:
					return _error_static("steps[%d].exists must be boolean" % index)
				clean_assert["exists"] = bool(exists_value)
			else:
				var property_value: Variant = step.get("property")
				if not property_value is String or not _is_safe_property_name(property_value as String):
					return _error_static("steps[%d].property must be a safe property name" % index)
				if not step.has("value"):
					return _error_static("steps[%d].value is required" % index)
				if not _is_json_value(step.get("value"), 0):
					return _error_static("steps[%d].value must be JSON-safe" % index)
				clean_assert["property"] = property_value
				clean_assert["value"] = step.get("value")
			return {
				"ok": true,
				"step": clean_assert,
				"frame_budget": timeout,
			}
		_:
			return _error_static("steps[%d].type is unsupported" % index)


static func _bounded_integer(value: Variant, minimum: int, maximum: int) -> Dictionary:
	if value is bool:
		return {"ok": false}
	if value is int:
		var integer_value: int = int(value)
		if integer_value < minimum or integer_value > maximum:
			return {"ok": false}
		return {"ok": true, "value": integer_value}
	if not value is float:
		return {"ok": false}
	var float_value: float = float(value)
	if is_nan(float_value) or is_inf(float_value) or float_value != floor(float_value):
		return {"ok": false}
	if float_value < float(minimum) or float_value > float(maximum):
		return {"ok": false}
	return {"ok": true, "value": int(float_value)}


static func _is_safe_action_name(value: String) -> bool:
	if value.is_empty() or value.length() > 128 or value.strip_edges() != value:
		return false
	for index in range(value.length()):
		var character: int = value.unicode_at(index)
		if character < 32 or character == 127:
			return false
	return true


static func _is_safe_property_name(value: String) -> bool:
	if value.is_empty() or value.length() > MAX_PROPERTY_NAME_CHARS:
		return false
	if value.begins_with("/") or value.ends_with("/") or value.contains("//"):
		return false
	for segment in value.split("/", true):
		if segment.is_empty():
			return false
		for index in range(segment.length()):
			var character: int = segment.unicode_at(index)
			var is_digit: bool = character >= 48 and character <= 57
			var is_upper: bool = character >= 65 and character <= 90
			var is_lower: bool = character >= 97 and character <= 122
			if index == 0 and not is_upper and not is_lower and character != 95:
				return false
			if index > 0 and not is_digit and not is_upper and not is_lower and character != 95:
				return false
	return true


static func _is_json_value(value: Variant, depth: int) -> bool:
	if depth > 8:
		return false
	if value == null or value is bool or value is int or value is float or value is String:
		return true
	if value is Array:
		if (value as Array).size() > 256:
			return false
		for item in (value as Array):
			if not _is_json_value(item, depth + 1):
				return false
		return true
	if value is Dictionary:
		if (value as Dictionary).size() > 256:
			return false
		for key in (value as Dictionary).keys():
			if not key is String or not _is_json_value((value as Dictionary)[key], depth + 1):
				return false
		return true
	return false


func _start_step() -> void:
	var index: int = int(_active.get("current_step", 0))
	var steps: Array = _active.get("steps", [])
	if index < 0 or index >= steps.size() or not steps[index] is Dictionary:
		_fail_step("The active automation plan is corrupt")
		return
	var step: Dictionary = steps[index]
	var step_type: String = str(step.get("type", ""))
	match step_type:
		"wait_frames":
			_step_state = {"phase": "wait", "remaining": int(step.get("frames", 1))}
		"click_control":
			_start_click(step)
		"press_action":
			_start_action(step)
		"assert_node":
			_step_state = {
				"phase": "assert",
				"remaining": int(step.get("timeout_frames", 0)),
			}
			_check_assertion(step)
		_:
			_fail_step("Unsupported automation step")


func _advance_step() -> void:
	var phase: String = str(_step_state.get("phase", ""))
	match phase:
		"wait":
			var remaining: int = int(_step_state.get("remaining", 0)) - 1
			_step_state["remaining"] = remaining
			if remaining <= 0:
				_pass_step("Wait completed")
		"click_motion_wait":
			_advance_click_after_motion()
		"click_press_wait":
			_release_click_and_pass()
		"action_hold":
			pass
		"assert":
			var steps: Array = _active.get("steps", [])
			var index: int = int(_active.get("current_step", 0))
			if index < 0 or index >= steps.size() or not steps[index] is Dictionary:
				_fail_step("The active assertion is unavailable")
				return
			_check_assertion(steps[index] as Dictionary)
		_:
			_fail_step("The automation step state is invalid")


func _start_click(step: Dictionary) -> void:
	var resolution: Dictionary = _resolve_current_scene_node(str(step.get("node_path", "")))
	if not bool(resolution.get("ok", false)):
		_fail_step(str(resolution.get("error", "Control not found")))
		return
	var node_value: Variant = resolution.get("node")
	if not node_value is Control:
		_fail_step("The click target is not a Control")
		return
	var control: Control = node_value as Control
	if not control.is_visible_in_tree():
		_fail_step("The click target is not visible")
		return
	var viewport: Viewport = control.get_viewport()
	if viewport == null:
		_fail_step("The click target viewport is unavailable")
		return
	var local_center: Vector2 = control.size * 0.5
	var canvas_position: Vector2 = control.get_global_transform_with_canvas() * local_center
	var input_position: Vector2 = canvas_position
	if not viewport is SubViewport:
		input_position = viewport.get_screen_transform() * canvas_position
	var button: int = int(step.get("button", 1))
	var motion: InputEventMouseMotion = InputEventMouseMotion.new()
	motion.position = input_position
	motion.global_position = input_position
	motion.button_mask = 0
	_dispatch_mouse_event(viewport, motion)
	_step_state = {
		"phase": "click_motion_wait",
		"control": control,
		"viewport": viewport,
		"position": input_position,
		"button": button,
	}


func _advance_click_after_motion() -> void:
	var control_value: Variant = _step_state.get("control")
	var viewport_value: Variant = _step_state.get("viewport")
	if not control_value is Control or not is_instance_valid(control_value):
		_fail_step("The click target disappeared")
		return
	if not viewport_value is Viewport or not is_instance_valid(viewport_value):
		_fail_step("The click target viewport disappeared")
		return
	var control: Control = control_value as Control
	var viewport: Viewport = viewport_value as Viewport
	var hovered: Control = viewport.gui_get_hovered_control()
	if hovered == null or (hovered != control and not control.is_ancestor_of(hovered)):
		_fail_step("The requested Control is not receiving pointer input")
		return
	var button: int = int(_step_state.get("button", 1))
	var position: Vector2 = _step_state.get("position", Vector2.ZERO)
	var press: InputEventMouseButton = _make_mouse_button(position, button, true)
	_dispatch_mouse_event(viewport, press)
	_held_mouse = {
		"viewport": viewport,
		"position": position,
		"button": button,
	}
	_step_state["phase"] = "click_press_wait"


func _release_click_and_pass() -> void:
	_release_held_mouse()
	_pass_step("Control clicked")


func _start_action(step: Dictionary) -> void:
	var action: String = str(step.get("action", ""))
	if not InputMap.has_action(action):
		_fail_step("InputMap action does not exist: %s" % action)
		return
	var pressed: bool = bool(step.get("pressed", true))
	_send_action(action, pressed)
	if not pressed:
		_held_actions.erase(action)
		_pass_step("Input action released")
		return
	_held_actions[action] = true
	_step_state = {
		"phase": "action_hold",
		"action": action,
		"remaining": int(step.get("duration_frames", 1)),
	}


func _check_assertion(step: Dictionary) -> void:
	var evaluation: Dictionary = _evaluate_assertion(step)
	if bool(evaluation.get("passed", false)):
		_pass_step(str(evaluation.get("message", "Assertion passed")))
		return
	var remaining: int = int(_step_state.get("remaining", 0))
	if remaining <= 0:
		_fail_step(str(evaluation.get("message", "Assertion failed")))
		return
	_step_state["remaining"] = remaining - 1


func _evaluate_assertion(step: Dictionary) -> Dictionary:
	var path: String = str(step.get("node_path", ""))
	var resolution: Dictionary = _resolve_current_scene_node(path)
	var exists: bool = bool(resolution.get("ok", false))
	var check: String = str(step.get("check", ""))
	if check == "exists":
		var expected_exists: bool = bool(step.get("exists", true))
		return {
			"passed": exists == expected_exists,
			"message": (
				"Node existence matched"
				if exists == expected_exists
				else "Expected node existence to be %s" % str(expected_exists)
			),
		}
	if not exists:
		return {"passed": false, "message": "Assertion target does not exist: %s" % path}
	var node: Node = resolution.get("node") as Node
	var property_name: String = str(step.get("property", ""))
	if not _has_property(node, property_name):
		return {"passed": false, "message": "Property does not exist: %s" % property_name}
	var actual: Variant = node.get(property_name)
	var expected: Variant = step.get("value")
	if check == "property_equals":
		var equals: bool = actual == expected
		return {
			"passed": equals,
			"message": (
				"Property equals the expected value"
				if equals
				else "Property value was %s" % _summarize(actual)
			),
		}
	var contains: bool = _variant_contains(actual, expected)
	return {
		"passed": contains,
		"message": (
			"Property contains the expected value"
			if contains
			else "Property value did not contain %s" % _summarize(expected)
		),
	}


func _resolve_current_scene_node(path: String) -> Dictionary:
	if not is_safe_node_path(path):
		return {"ok": false, "error": "Unsafe current-scene node path"}
	if _tree == null or _tree.current_scene == null:
		return {"ok": false, "error": "The running current scene is unavailable"}
	var root: Node = _tree.current_scene
	var node: Node = root if path == "." else root.get_node_or_null(NodePath(path))
	if node == null:
		return {"ok": false, "error": "Node not found in the current scene: %s" % path}
	if node != root and not root.is_ancestor_of(node):
		return {"ok": false, "error": "Node resolved outside the current scene"}
	return {"ok": true, "node": node}


func _dispatch_mouse_event(viewport: Viewport, event: InputEventMouse) -> void:
	if viewport is SubViewport:
		viewport.push_input(event, true)
	else:
		Input.parse_input_event(event)


func _make_mouse_button(position: Vector2, button: int, pressed: bool) -> InputEventMouseButton:
	var event: InputEventMouseButton = InputEventMouseButton.new()
	event.position = position
	event.global_position = position
	event.button_index = button
	event.pressed = pressed
	event.button_mask = _button_mask(button) if pressed else 0
	return event


func _button_mask(button: int) -> int:
	match button:
		1:
			return MOUSE_BUTTON_MASK_LEFT
		2:
			return MOUSE_BUTTON_MASK_RIGHT
		3:
			return MOUSE_BUTTON_MASK_MIDDLE
		_:
			return 0


func _send_action(action: String, pressed: bool) -> void:
	var event: InputEventAction = InputEventAction.new()
	event.action = action
	event.pressed = pressed
	event.strength = 1.0 if pressed else 0.0
	Input.parse_input_event(event)


func _release_held_inputs() -> void:
	var actions: Array = _held_actions.keys()
	for action_value in actions:
		_send_action(str(action_value), false)
	_held_actions.clear()
	_release_held_mouse()


func _release_held_mouse() -> void:
	if _held_mouse.is_empty():
		return
	var viewport_value: Variant = _held_mouse.get("viewport")
	if viewport_value is Viewport and is_instance_valid(viewport_value):
		var viewport: Viewport = viewport_value as Viewport
		var position: Vector2 = _held_mouse.get("position", Vector2.ZERO)
		var button: int = int(_held_mouse.get("button", 1))
		_dispatch_mouse_event(viewport, _make_mouse_button(position, button, false))
	_held_mouse.clear()


func _pass_step(message: String) -> void:
	_finish_step(true, message)


func _fail_step(message: String) -> void:
	_release_held_inputs()
	_finish_step(false, message)


func _finish_step(passed: bool, message: String) -> void:
	if _active.is_empty():
		return
	var index: int = int(_active.get("current_step", 0))
	var steps: Array = _active.get("steps", [])
	var step_type: String = "unknown"
	if index >= 0 and index < steps.size() and steps[index] is Dictionary:
		step_type = str((steps[index] as Dictionary).get("type", "unknown"))
	var results: Array = _active.get("results", [])
	results.append({
		"index": index,
		"type": step_type,
		"state": "passed" if passed else "failed",
		"message": _limited(message, MAX_RESULT_TEXT_CHARS),
	})
	_active["results"] = results
	_active["current_step"] = index + 1
	_step_state.clear()
	if not passed:
		_active["had_failure"] = true
		if str(_active.get("failure", "")).is_empty():
			_active["failure"] = _limited(message, MAX_RESULT_TEXT_CHARS)
		if bool(_active.get("stop_on_failure", true)):
			_finish_plan("failed", str(_active.get("failure", "Automation step failed")))
			return
	if int(_active.get("current_step", 0)) >= int(_active.get("step_count", 0)):
		_finish_completed_plan()
	else:
		_emit_status()


func _finish_completed_plan() -> void:
	if bool(_active.get("had_failure", false)):
		_finish_plan("failed", str(_active.get("failure", "One or more assertions failed")))
	else:
		_finish_plan("passed")


func _finish_plan(state: String, failure: String = "") -> void:
	if _active.is_empty():
		return
	_release_held_inputs()
	_active["state"] = state
	_active["ended_at_ms"] = Time.get_ticks_msec()
	if not failure.is_empty():
		_active["failure"] = _limited(failure, MAX_RESULT_TEXT_CHARS)
	if state == "passed":
		_active["current_step"] = int(_active.get("step_count", 0))
	_emit_status()
	_active.clear()
	_step_state.clear()


func _emit_rejection(automation_id: String, error: String, step_count: int = 0) -> void:
	var now: int = Time.get_ticks_msec()
	_emit({
		"v": PROTOCOL_VERSION,
		"automation_id": automation_id,
		"run_id": _run_id,
		"state": "failed",
		"current_step": 0,
		"step_count": clampi(step_count, 0, MAX_STEPS),
		"results": [],
		"failure": _limited(error, MAX_RESULT_TEXT_CHARS),
		"started_at_ms": now,
		"ended_at_ms": now,
	})


func _emit_status() -> void:
	if _active.is_empty():
		return
	var status: Dictionary = {
		"v": PROTOCOL_VERSION,
		"automation_id": str(_active.get("automation_id", "")),
		"run_id": _run_id,
		"state": str(_active.get("state", "running")),
		"current_step": int(_active.get("current_step", 0)),
		"step_count": int(_active.get("step_count", 0)),
		"results": (_active.get("results", []) as Array).duplicate(true),
		"started_at_ms": int(_active.get("started_at_ms", 0)),
		"ended_at_ms": int(_active.get("ended_at_ms", 0)),
	}
	var failure: String = str(_active.get("failure", ""))
	if not failure.is_empty():
		status["failure"] = failure
	_emit(status)


func _emit_heartbeat_if_due() -> void:
	if _active.is_empty():
		return
	var now: int = Time.get_ticks_msec()
	if now < _next_heartbeat_at_ms:
		return
	_next_heartbeat_at_ms = now + HEARTBEAT_INTERVAL_MS
	_emit_status()


func _emit(status: Dictionary) -> void:
	if _event_sink.is_valid():
		_event_sink.call(status)


static func _has_property(object: Object, property_name: String) -> bool:
	for descriptor_value in object.get_property_list():
		if descriptor_value is Dictionary and str((descriptor_value as Dictionary).get("name", "")) == property_name:
			return true
	return false


static func _variant_contains(actual: Variant, expected: Variant) -> bool:
	if actual is String and expected is String:
		return (actual as String).contains(expected as String)
	if actual is Array:
		return (actual as Array).has(expected)
	if actual is Dictionary:
		return (actual as Dictionary).has(expected)
	return false


static func _summarize(value: Variant) -> String:
	var text: String = str(value)
	return text if text.length() <= MAX_RESULT_TEXT_CHARS else text.left(MAX_RESULT_TEXT_CHARS)


static func _limited(value: String, limit: int) -> String:
	return value if value.length() <= limit else value.left(limit)


static func _error_static(message: String) -> Dictionary:
	return {"ok": false, "error": message}
