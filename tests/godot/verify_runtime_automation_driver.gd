extends SceneTree

const RuntimeAutomationDriver := preload("res://addons/godetx/runtime_automation_driver.gd")
const RuntimeProbe := preload("res://addons/godetx/runtime_probe.gd")

const RUN_ID := "0123456789abcdef0123456789abcdef"
const AUTOMATION_ID := "fedcba9876543210fedcba9876543210"

var _failures: PackedStringArray = PackedStringArray()
var _events: Array[Dictionary] = []


func _init() -> void:
	var valid: Dictionary = RuntimeAutomationDriver.validate_steps([
		{"type": "wait_frames", "frames": 2},
		{"type": "press_action", "action": "ui_accept"},
		{"type": "click_control", "node_path": "Panel/StartButton"},
		{
			"type": "assert_node",
			"node_path": "Panel/Title",
			"check": "property_contains",
			"property": "text",
			"value": "Ready",
			"timeout_frames": 30,
		},
	])
	_assert(bool(valid.get("ok", false)), "A bounded automation plan should validate")
	var clean_steps: Array = valid.get("steps", [])
	_assert(
		clean_steps.size() == 4
		and int((clean_steps[1] as Dictionary).get("duration_frames", 0)) == 1,
		"Action duration should receive the one-frame default"
	)
	var integral_float_fields: Dictionary = RuntimeAutomationDriver.validate_steps([
		{"type": "wait_frames", "frames": 2.0},
		{"type": "click_control", "node_path": "Panel/StartButton", "button": 1.0},
		{
			"type": "press_action",
			"action": "ui_accept",
			"duration_frames": 3.0,
		},
		{
			"type": "assert_node",
			"node_path": ".",
			"check": "exists",
			"timeout_frames": 4.0,
		},
	])
	_assert(
		bool(integral_float_fields.get("ok", false)),
		"Integral JSON floats should validate for every bounded integer field"
	)
	if bool(integral_float_fields.get("ok", false)):
		var normalized_float_steps: Array = integral_float_fields.get("steps", [])
		_assert(
			typeof((normalized_float_steps[0] as Dictionary).get("frames")) == TYPE_INT
			and int((normalized_float_steps[0] as Dictionary).get("frames", 0)) == 2
			and typeof((normalized_float_steps[1] as Dictionary).get("button")) == TYPE_INT
			and int((normalized_float_steps[1] as Dictionary).get("button", 0)) == 1
			and typeof((normalized_float_steps[2] as Dictionary).get("duration_frames")) == TYPE_INT
			and int((normalized_float_steps[2] as Dictionary).get("duration_frames", 0)) == 3
			and typeof((normalized_float_steps[3] as Dictionary).get("timeout_frames")) == TYPE_INT
			and int((normalized_float_steps[3] as Dictionary).get("timeout_frames", -1)) == 4,
			"Integral JSON floats should be normalized to bounded ints"
		)
	_assert(
		not bool(RuntimeAutomationDriver.validate_steps([
			{"type": "click_control", "node_path": ".", "button": 1.5},
		]).get("ok", true)),
		"Fractional JSON numbers must not be truncated for integer fields"
	)
	_assert(
		not bool(RuntimeAutomationDriver.validate_steps([
			{"type": "click_control", "node_path": ".", "button": 4.0},
		]).get("ok", true)),
		"Integral JSON floats outside a field's bounds must be rejected"
	)
	_assert(
		not bool(RuntimeAutomationDriver.validate_steps([
			{"type": "wait_frames", "frames": NAN},
		]).get("ok", true)),
		"Non-finite JSON numbers must not be accepted for integer fields"
	)
	_assert(
		not bool(RuntimeAutomationDriver.validate_steps([
			{"type": "assert_node", "node_path": ".", "check": "exists", "timeout_frames": true},
		]).get("ok", true)),
		"Booleans must not be accepted for integer fields"
	)
	_assert(
		not bool(RuntimeAutomationDriver.validate_steps([
			{"type": "click_control", "node_path": "../Outside"},
		]).get("ok", true)),
		"Automation paths must not traverse outside current_scene"
	)
	_assert(
		not bool(RuntimeAutomationDriver.validate_steps([
			{"type": "press_action", "action": "ui_accept", "pressed": false, "duration_frames": 1},
		]).get("ok", true)),
		"Release-only actions must reject duration_frames"
	)
	var release_only: Dictionary = RuntimeAutomationDriver.validate_steps([
		{"type": "press_action", "action": "ui/accept:alternate", "pressed": false},
	])
	_assert(bool(release_only.get("ok", false)), "Trimmed action names accepted by the host should validate")
	if bool(release_only.get("ok", false)):
		var release_steps: Array = release_only.get("steps", [])
		_assert(
			not (release_steps[0] as Dictionary).has("duration_frames")
			and bool(RuntimeAutomationDriver.validate_steps(release_steps).get("ok", false)),
			"Normalized release-only actions must survive probe-to-driver revalidation"
		)
	var long_property: String = "property_" + "a".repeat(247)
	_assert(
		long_property.length() == 256
		and bool(RuntimeAutomationDriver.validate_steps([{
			"type": "assert_node",
			"node_path": ".",
			"check": "property_equals",
			"property": long_property,
			"value": 1,
		}]).get("ok", false)),
		"Host-valid property names up to 256 characters should validate"
	)
	_assert(
		not bool(RuntimeAutomationDriver.validate_steps([{
			"type": "assert_node",
			"node_path": ".",
			"check": "property_equals",
			"property": "%sa" % long_property,
			"value": 1,
		}]).get("ok", true)),
		"Property names longer than the host's 256-character bound must fail"
	)
	_assert(
		not bool(RuntimeAutomationDriver.validate_steps([
			{"type": "press_action", "action": " ui_accept"},
		]).get("ok", true)),
		"Action names with surrounding whitespace must match host-side rejection"
	)
	_assert(
		not bool(RuntimeAutomationDriver.validate_steps([
			{"type": "wait_frames", "frames": 3600.0},
			{"type": "wait_frames", "frames": 3600.0},
			{"type": "wait_frames", "frames": 1.0},
		]).get("ok", true)),
		"Normalized integral floats must still enforce the aggregate frame budget"
	)

	var envelope: Dictionary = RuntimeProbe._validate_automation_envelope([{
		"v": 1,
		"run_id": RUN_ID,
		"automation_id": AUTOMATION_ID,
		"kind": "execute",
		"steps": [{"type": "assert_node", "node_path": ".", "check": "exists"}],
	}], RUN_ID)
	_assert(bool(envelope.get("ok", false)), "A matching runtime envelope should validate")
	_assert(
		not bool(RuntimeProbe._validate_automation_envelope([{
			"v": 1,
			"run_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"automation_id": AUTOMATION_ID,
			"kind": "cancel",
		}], RUN_ID).get("ok", true)),
		"The runtime probe must reject envelopes for another run"
	)

	var scene: Node = Node.new()
	scene.name = "AutomationScene"
	get_root().add_child(scene)
	current_scene = scene
	var label: Label = Label.new()
	label.name = "Title"
	label.text = "Ready"
	scene.add_child(label)

	var driver: Variant = RuntimeAutomationDriver.new(self, RUN_ID, _on_event)
	driver.execute({
		"automation_id": AUTOMATION_ID,
		"steps": [
			{"type": "wait_frames", "frames": 1},
			{
				"type": "assert_node",
				"node_path": "Title",
				"check": "property_equals",
				"property": "text",
				"value": "Ready",
			},
		],
		"stop_on_failure": true,
	})
	for _frame in range(6):
		driver.process_frame()
	_assert(not _events.is_empty(), "The driver should emit status events")
	if not _events.is_empty():
		var final_event: Dictionary = _events.back()
		_assert(str(final_event.get("state", "")) == "passed", "A matching assertion should pass")
		_assert(int(final_event.get("current_step", 0)) == 2, "Passed plans should report all steps complete")

	_events.clear()
	var cancel_id: String = "11111111111111111111111111111111"
	driver.execute({
		"automation_id": cancel_id,
		"steps": [{"type": "wait_frames", "frames": 60}],
	})
	driver.process_frame()
	_assert(driver.cancel(cancel_id), "The active automation should be cancellable")
	if not _events.is_empty():
		_assert(str(_events.back().get("state", "")) == "cancelled", "Cancellation should be terminal")

	_events.clear()
	var failing_id: String = "22222222222222222222222222222222"
	driver.execute({
		"automation_id": failing_id,
		"steps": [{
			"type": "assert_node",
			"node_path": "Missing",
			"check": "exists",
		}],
	})
	driver.process_frame()
	if not _events.is_empty():
		var failed_event: Dictionary = _events.back()
		_assert(str(failed_event.get("state", "")) == "failed", "A failed assertion should be terminal")
		_assert(
			int(failed_event.get("current_step", 0)) == 1
			and (failed_event.get("results", []) as Array).size() == 1,
			"Terminal failures should report the completed failed step consistently"
		)

	driver.shutdown()
	scene.free()
	if not _failures.is_empty():
		for failure in _failures:
			printerr(failure)
		quit(1)
		return
	print("GODETX_RUNTIME_AUTOMATION_DRIVER_OK")
	quit(0)


func _on_event(event: Dictionary) -> void:
	_events.append(event.duplicate(true))


func _assert(condition: bool, message: String) -> void:
	if not condition:
		_failures.append(message)
