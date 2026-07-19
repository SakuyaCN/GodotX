extends SceneTree

const EditorGameDebugger := preload("res://addons/godetx/editor_game_debugger.gd")
const GodotXPlugin := preload("res://addons/godetx/plugin.gd")
const RuntimeProbe := preload("res://addons/godetx/runtime_probe.gd")

var _failures := PackedStringArray()


func _init() -> void:
	var probe_resource_id := ResourceLoader.get_resource_uid(
		"res://addons/godetx/runtime_probe.gd"
	)
	var probe_uid := ResourceUID.id_to_text(probe_resource_id)
	_assert(
		GodotXPlugin._normalize_autoload_path("*%s" % probe_uid)
			== "res://addons/godetx/runtime_probe.gd",
		"Autoload UID settings should resolve to the RuntimeProbe resource path"
	)
	var debugger = EditorGameDebugger.new()
	var armed: Dictionary = debugger.arm_run("scene", "res://demo/main.tscn")
	_assert(bool(armed.get("ok", false)), "A project scene should arm a debug run")
	var run_id := str(armed.get("run_id", ""))
	_assert(run_id.length() == 32, "Debug runs should use a 128-bit hexadecimal ID")

	var original_args := PackedStringArray(["--editor-pid", "123"])
	var decorated: PackedStringArray = debugger.decorate_run_args(
		"res://demo/main.tscn",
		original_args
	)
	var separator_index := decorated.find("--")
	var run_argument := "%s%s" % [debugger.RUN_ARGUMENT_PREFIX, run_id]
	_assert(separator_index >= 0, "Debug user arguments should include the Godot separator")
	_assert(
		decorated.find(run_argument) > separator_index,
		"The run ID must be passed as a user argument after the separator"
	)

	debugger._capture_hello([run_id, debugger.SUPPORTED_PROTOCOL_VERSION], 7)
	_assert(
		bool(debugger._session_state(7).get("probe_confirmed", false)),
		"A supported matching probe hello should retain its handshake state"
	)
	_assert(
		debugger._owned_session_id == 7,
		"The first supported matching probe hello should select the owned session ID"
	)
	var hello_before_ref: Dictionary = debugger._owned_session_binding(false, true)
	_assert(
		not bool(hello_before_ref.get("ok", true)),
		"A hello received before the debugger reference must not authorize commands"
	)
	_assert(
		debugger._owned and debugger._owned_session_id == 7,
		"A temporarily missing debugger reference must not discard the owned run identity"
	)
	debugger._capture_hello([run_id, debugger.SUPPORTED_PROTOCOL_VERSION], 8)
	_assert(debugger._owned_session_id == 7, "Later probe hellos must not replace the bound session")
	_assert(debugger._has_capture("godetx_automation"), "The editor debugger should capture automation events")
	_assert(debugger._has_capture("godetx_visual"), "The editor debugger should capture game screenshots")
	var accepted: Dictionary = debugger._ingest_log_batch(run_id, [
		{
			"kind": "message",
			"level": "info",
			"text": "game ready",
			"timestamp_ms": 10,
			"probe_seq": 1,
		},
	], 0, 7)
	_assert(int(accepted.get("accepted", 0)) == 1, "Owned runtime logs should be accepted")
	var status: Dictionary = debugger.snapshot(100)
	_assert(bool(status.get("owned", false)), "A decorated run should remain owned")
	_assert(bool(status.get("probe_confirmed", false)), "A matching hello should confirm the runtime probe")
	_assert((status.get("entries", []) as Array).size() >= 3, "Status should include lifecycle and game log entries")
	var cursor := int(status.get("next_seq", 0))
	debugger._ingest_log_batch(run_id, [
		{
			"kind": "message",
			"level": "info",
			"text": "next frame",
			"timestamp_ms": 11,
			"probe_seq": 2,
		},
	], 0, 7)
	var incremental: Dictionary = debugger.snapshot(100, cursor)
	var incremental_entries: Array = incremental.get("entries", [])
	_assert(incremental_entries.size() == 1, "Cursor reads should return only new output")
	_assert(
		int(incremental.get("next_seq", 0)) > cursor,
		"The next cursor should be the last returned sequence"
	)
	_assert(
		not bool(debugger._ingest_log_batch("stale-run", [], 0).get("ok", true)),
		"Logs from a stale run ID must be rejected"
	)
	debugger._on_session_started(9)
	_assert(
		str(debugger._session_state(9).get("run_id", "")).is_empty(),
		"An unconfirmed debugger session must not inherit the active run ownership"
	)
	var invalid_automation: Dictionary = debugger.automation_run(run_id, [{
		"type": "click_control",
		"node_path": "Board/Cell0",
		"button": 0,
	}])
	_assert(
		not bool(invalid_automation.get("ok", true)),
		"Invalid automation input should be rejected before dispatch"
	)
	_assert(
		debugger._owned and debugger._owned_session_id == 7,
		"Automation validation failures must not discard the bound game session"
	)
	var stale_owned_state: Dictionary = debugger._session_state(7)
	var stale_now: int = (
		int(stale_owned_state.get("last_probe_at_ms", 0))
		+ debugger.PROBE_STALE_AFTER_MS
		+ 1
	)
	_assert(
		debugger._session_proves_owned_binding(7, stale_owned_state, true),
		"A matching probe handshake should continue to prove the exact session identity"
	)
	_assert(
		not debugger._probe_is_fresh(stale_owned_state, stale_now),
		"Probe freshness should expire independently from session identity"
	)
	_assert(
		not debugger._session_proves_owned_binding(8, stale_owned_state, true),
		"A different debugger session must not inherit the owned binding"
	)
	_assert(
		not bool(debugger.stop_owned(run_id).get("ok", true)),
		"A debugger without a host EditorInterface must not stop a process"
	)
	var automation_id := "fedcba9876543210fedcba9876543210"
	debugger._automations[automation_id] = {
		"automation_id": automation_id,
		"run_id": run_id,
		"session_id": 7,
		"state": "queued",
		"current_step": 0,
		"step_count": 1,
		"results": [],
		"failure": "",
		"started_at_ms": 0,
		"ended_at_ms": 0,
		"queued_at_ms": Time.get_ticks_msec(),
		"last_event_at_ms": Time.get_ticks_msec(),
		"timeout_paused_at_ms": 0,
	}
	debugger._automation_order.append(automation_id)
	var wrong_session: Dictionary = debugger._ingest_automation_event({
		"v": 1,
		"run_id": run_id,
		"automation_id": automation_id,
		"state": "running",
		"current_step": 0,
		"step_count": 1,
		"results": [],
		"started_at_ms": 1,
		"ended_at_ms": 0,
	}, 8)
	_assert(not bool(wrong_session.get("ok", true)), "Automation events must match their bound session")
	var accepted_automation: Dictionary = debugger._ingest_automation_event({
		"v": 1,
		"run_id": run_id,
		"automation_id": automation_id,
		"state": "passed",
		"current_step": 1,
		"step_count": 1,
		"results": [{
			"index": 0,
			"type": "assert_node",
			"state": "passed",
			"message": "Node existence matched",
		}],
		"started_at_ms": 1,
		"ended_at_ms": 2,
	}, 7)
	_assert(bool(accepted_automation.get("ok", false)), "Bound automation events should be accepted")
	var automation_status: Dictionary = debugger.automation_status(run_id, automation_id)
	_assert(str(automation_status.get("state", "")) == "passed", "Automation status should retain terminal state")

	debugger._on_session_stopped(8)
	_assert(debugger._owned, "Stopping a different debugger session must not release the owned run")
	debugger._on_session_stopped(7)
	_assert(not debugger._owned, "Stopping the bound debugger session should release the owned run")

	var reset_debugger = EditorGameDebugger.new()
	# A sentinel is sufficient here because this verifies dictionary lifetime only;
	# no production binding method is allowed to consume it as an EditorDebuggerSession.
	var cached_session_sentinel: RefCounted = RefCounted.new()
	reset_debugger._session_refs[41] = cached_session_sentinel
	reset_debugger._sessions[41] = {
		"session_id": 41,
		"active": true,
		"probe_confirmed": true,
		"run_id": "previous-run",
	}
	reset_debugger._owned_session_id = 41
	var reset_armed: Dictionary = reset_debugger.arm_run("scene", "res://demo/main.tscn")
	_assert(bool(reset_armed.get("ok", false)), "A clean debugger should arm after resetting run state")
	_assert(
		reset_debugger._session_refs.get(41) == cached_session_sentinel,
		"Per-run reset must preserve plugin-lifetime debugger session references"
	)
	_assert(
		reset_debugger._sessions.is_empty(),
		"Per-run reset must discard the previous run's debugger handshake state"
	)
	_assert(
		reset_debugger._owned_session_id == -1,
		"Per-run reset must discard the previous run's owned session ID"
	)

	var next_run: Dictionary = debugger.arm_run("scene", "res://demo/main.tscn")
	_assert(bool(next_run.get("ok", false)), "A completed run should allow a new launch")
	var unchanged_source := PackedStringArray(["--path", "res://"])
	var unchanged: PackedStringArray = debugger.decorate_run_args(
		"res://demo/other.tscn",
		unchanged_source
	)
	_assert(unchanged == unchanged_source, "A mismatched launch target must not receive the run ID")
	var rejected_status: Dictionary = debugger.snapshot(100)
	_assert(not bool(rejected_status.get("owned", false)), "A mismatched launch must not be owned")
	_assert(not bool(rejected_status.get("armed", true)), "A mismatched launch should consume the arm")

	var safe_id := "0123456789abcdef0123456789abcdef"
	_assert(
		RuntimeProbe._read_run_id(PackedStringArray(["--", "%s%s" % [RuntimeProbe.RUN_ARGUMENT_PREFIX, safe_id]])) == safe_id,
		"RuntimeProbe should accept a safe user run ID"
	)
	_assert(
		RuntimeProbe._read_run_id(PackedStringArray(["%sbad id" % RuntimeProbe.RUN_ARGUMENT_PREFIX])).is_empty(),
		"RuntimeProbe should reject unsafe run IDs"
	)
	var capture_id := "1234567890abcdef1234567890abcdef"
	var valid_visual: Dictionary = RuntimeProbe._validate_visual_envelope([{
		"v": RuntimeProbe.VISUAL_PROTOCOL_VERSION,
		"run_id": safe_id,
		"capture_id": capture_id,
		"max_dimension": 1280.0,
	}], safe_id)
	_assert(bool(valid_visual.get("ok", false)), "A bounded screenshot request should be accepted")
	_assert(
		int((valid_visual.get("request", {}) as Dictionary).get("max_dimension", 0)) == 1280
		and typeof((valid_visual.get("request", {}) as Dictionary).get("max_dimension")) == TYPE_INT,
		"Screenshot validation should normalize integral JSON floats to bounded ints"
	)
	var fractional_visual: Dictionary = RuntimeProbe._validate_visual_envelope([{
		"v": RuntimeProbe.VISUAL_PROTOCOL_VERSION,
		"run_id": safe_id,
		"capture_id": capture_id,
		"max_dimension": 1280.5,
	}], safe_id)
	var non_finite_visual: Dictionary = RuntimeProbe._validate_visual_envelope([{
		"v": RuntimeProbe.VISUAL_PROTOCOL_VERSION,
		"run_id": safe_id,
		"capture_id": capture_id,
		"max_dimension": NAN,
	}], safe_id)
	_assert(
		not bool(fractional_visual.get("ok", true))
		and not bool(non_finite_visual.get("ok", true)),
		"Screenshot envelopes must reject fractional and non-finite dimensions"
	)
	var wrong_visual_run: Dictionary = RuntimeProbe._validate_visual_envelope([{
		"v": RuntimeProbe.VISUAL_PROTOCOL_VERSION,
		"run_id": "fedcba9876543210fedcba9876543210",
		"capture_id": capture_id,
		"max_dimension": 1280,
	}], safe_id)
	_assert(
		not bool(wrong_visual_run.get("ok", true)),
		"Screenshot requests must match the exact running game ID"
	)
	var oversized_visual: Dictionary = RuntimeProbe._validate_visual_envelope([{
		"v": RuntimeProbe.VISUAL_PROTOCOL_VERSION,
		"run_id": safe_id,
		"capture_id": capture_id,
		"max_dimension": RuntimeProbe.MAX_VISUAL_DIMENSION + 1,
	}], safe_id)
	_assert(
		not bool(oversized_visual.get("ok", true)),
		"Screenshot requests must enforce the maximum encoded dimensions"
	)

	if not _failures.is_empty():
		for failure in _failures:
			printerr(failure)
		quit(1)
		return
	print("GODETX_EDITOR_GAME_DEBUGGER_OK")
	quit(0)


func _assert(condition: bool, message: String) -> void:
	if not condition:
		_failures.append(message)
