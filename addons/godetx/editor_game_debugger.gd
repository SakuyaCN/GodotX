@tool
class_name GodetXEditorGameDebugger
extends EditorDebuggerPlugin

const RuntimeAutomationDriver := preload("res://addons/godetx/runtime_automation_driver.gd")
const AttachmentStore := preload("res://addons/godetx/attachment_store.gd")

const RUN_ARGUMENT_PREFIX := "--godetx-run-id="
const SUPPORTED_PROTOCOL_VERSION := 1
const MAX_RING_ENTRIES := 1024
const MAX_RING_BYTES := 1_000_000
const MAX_TEXT_CHARS := 4096
const MAX_CONTEXT_CHARS := 512
const MAX_BACKTRACES := 2
const MAX_BACKTRACE_FRAMES := 16
const MAX_CAPTURE_BATCH_ENTRIES := 32
const MAX_CAPTURE_BATCH_BYTES := 16 * 1024
const MAX_REPORTED_DROPPED := 1_000_000
const ARM_TIMEOUT_MS := 5_000
const LAUNCH_OBSERVE_GRACE_MS := 1_000
const MAX_AUTOMATION_RECORDS := 32
const AUTOMATION_QUEUE_TIMEOUT_MS := 5_000
const AUTOMATION_ACTIVE_TIMEOUT_MS := 300_000
const AUTOMATION_PROTOCOL_VERSION := 1
const PROBE_STALE_AFTER_MS := 2_500
const VISUAL_PROTOCOL_VERSION := 1
const MIN_VISUAL_DIMENSION := 64
const MAX_VISUAL_DIMENSION := 2048
const MAX_VISUAL_BYTES := 8 * 1024 * 1024
const MAX_PENDING_VISUAL_CAPTURES := 4

var editor_interface: EditorInterface
var runtime_probe_available: bool = true
var runtime_probe_error: String = ""

var _run_id: String = ""
var _run_mode: String = ""
var _requested_scene_path: String = ""
var _launched_scene_path: String = ""
var _armed: bool = false
var _owned: bool = false
var _launch_observed: bool = false
var _probe_confirmed: bool = false
var _stop_requested: bool = false
var _armed_at_ms: int = 0
var _started_at_ms: int = 0
var _ended_at_ms: int = 0
var _next_sequence: int = 1
var _discarded_entries: int = 0
var _runtime_dropped_entries: int = 0
var _ring_bytes: int = 0
var _entries: Array[Dictionary] = []
var _entry_sizes: Array[int] = []
var _sessions: Dictionary = {}
# EditorDebuggerSession objects outlive individual game runs. Godot may call
# _setup_session() only once and then reuse the same object across started/stopped.
var _session_refs: Dictionary = {}
var _owned_session_id: int = -1
var _automations: Dictionary = {}
var _automation_order: Array[String] = []
var _visual_captures: Dictionary = {}
var _visual_callbacks: Dictionary = {}
var _attachment_store = AttachmentStore.new()


func _init(
	value: EditorInterface = null,
	probe_available: bool = true,
	probe_error: String = ""
) -> void:
	editor_interface = value
	runtime_probe_available = probe_available
	runtime_probe_error = probe_error


func configure_runtime_probe(available: bool, error: String = "") -> void:
	runtime_probe_available = available
	runtime_probe_error = error


func set_probe_available(available: bool, error: String = "") -> void:
	configure_runtime_probe(available, error)


func arm_run(mode: String, scene_path: String = "") -> Dictionary:
	_sync_play_state()
	if not runtime_probe_available:
		return _error(
			runtime_probe_error
			if not runtime_probe_error.is_empty()
			else "The GodotX runtime probe is unavailable"
		)
	if _armed or _owned:
		return _error("A GodotX game run is already active or launching")
	if editor_interface != null and editor_interface.is_playing_scene():
		return _error("A game is already running; GodotX will not take ownership of it")
	if mode != "main" and mode != "current" and mode != "scene":
		return _error("mode must be main, current, or scene")
	var normalized_path: String = _normalize_scene_path(scene_path)
	if (mode == "current" or mode == "scene") and normalized_path.is_empty():
		return _error("A stable scene path is required for this launch mode")
	if not normalized_path.is_empty() and not normalized_path.begins_with("res://"):
		return _error("scene_path must resolve inside the current project")

	_reset_for_new_run()
	_run_id = _generate_run_id()
	_run_mode = mode
	_requested_scene_path = normalized_path
	_armed = true
	_armed_at_ms = Time.get_ticks_msec()
	_append_lifecycle("launch_armed", {
		"mode": _run_mode,
		"scene_path": _requested_scene_path,
	})
	return {
		"ok": true,
		"run_id": _run_id,
		"mode": _run_mode,
		"scene_path": _requested_scene_path,
	}


func decorate_run_args(scene: String, args: PackedStringArray) -> PackedStringArray:
	if not _armed or _run_id.is_empty():
		return args
	var normalized_launch_path: String = _normalize_scene_path(scene)
	if (
		not _requested_scene_path.is_empty()
		and normalized_launch_path != _requested_scene_path
	):
		_append_lifecycle("launch_rejected", {
			"reason": "The editor launched a different scene",
			"expected_scene_path": _requested_scene_path,
			"actual_scene_path": normalized_launch_path,
		})
		_armed = false
		_ended_at_ms = Time.get_ticks_msec()
		return args

	var decorated: PackedStringArray = PackedStringArray()
	for argument in args:
		if not argument.begins_with(RUN_ARGUMENT_PREFIX):
			decorated.append(argument)
	if decorated.find("--") < 0:
		decorated.append("--")
	decorated.append("%s%s" % [RUN_ARGUMENT_PREFIX, _run_id])

	_armed = false
	_owned = true
	_launched_scene_path = normalized_launch_path
	_started_at_ms = Time.get_ticks_msec()
	_append_lifecycle("launch_decorated", {
		"mode": _run_mode,
		"scene_path": _launched_scene_path,
	})
	return decorated


func cancel_armed_run(expected_run_id: String, reason: String) -> Dictionary:
	if not _armed or expected_run_id != _run_id:
		return _error("The requested GodotX launch is no longer armed")
	_armed = false
	_ended_at_ms = Time.get_ticks_msec()
	_append_lifecycle("launch_cancelled", {"reason": _limited(reason, MAX_TEXT_CHARS)})
	return {"ok": true, "run_id": _run_id}


func snapshot(history_limit: int = 100, after_seq: int = 0) -> Dictionary:
	_sync_play_state()
	return _snapshot_impl(after_seq, history_limit)


func snapshot_since(after_seq: int, history_limit: int = 100) -> Dictionary:
	_sync_play_state()
	return _snapshot_impl(after_seq, history_limit)


func stop_owned(expected_run_id: String = "") -> Dictionary:
	_sync_play_state()
	var stopping_run_id: String = _run_id
	if expected_run_id.is_empty():
		return _error("run_id is required to stop a GodotX game")
	if expected_run_id != stopping_run_id:
		return _error("run_id does not match the active GodotX run")
	if not _owned or stopping_run_id.is_empty():
		return _error("GodotX does not own the currently running game")
	# A fresh probe is required before sending automation messages, but not before
	# stopping the exact debugger session that already proved this run ID.
	var binding: Dictionary = _owned_session_binding(false, true)
	if not bool(binding.get("ok", false)):
		return _error("GodotX cannot prove ownership of the active debugger session")
	if editor_interface == null or not editor_interface.is_playing_scene():
		return _error("The owned GodotX game is no longer running")
	_stop_requested = true
	_append_lifecycle("stop_requested")
	editor_interface.stop_playing_scene()
	return {
		"ok": true,
		"run_id": stopping_run_id,
		"stop_requested": true,
	}


func owns_run(run_id: String = "") -> bool:
	_sync_play_state()
	return _owned and (run_id.is_empty() or run_id == _run_id)


func automation_run(
	expected_run_id: String,
	steps: Variant,
	stop_on_failure: bool = true
) -> Dictionary:
	_sync_play_state()
	_sync_automation_timeouts()
	var ownership: Dictionary = _validate_automation_ownership(expected_run_id)
	if not bool(ownership.get("ok", false)):
		return ownership
	for record_value in _automations.values():
		if not record_value is Dictionary:
			continue
		var existing: Dictionary = record_value as Dictionary
		if (
			str(existing.get("run_id", "")) == expected_run_id
			and _is_active_automation_state(str(existing.get("state", "")))
		):
			return _error("Another runtime automation plan is already active")
	var validation: Dictionary = RuntimeAutomationDriver.validate_steps(steps)
	if not bool(validation.get("ok", false)):
		return _error(str(validation.get("error", "Invalid automation plan")))
	if not _ensure_automation_capacity():
		return _error("The runtime automation history is full")
	var binding: Dictionary = _owned_probe_session_binding()
	if not bool(binding.get("ok", false)):
		return binding
	var session_value: Variant = binding.get("session")
	if not session_value is EditorDebuggerSession:
		return _error("The owned debugger session is unavailable")
	var session: EditorDebuggerSession = session_value as EditorDebuggerSession
	var automation_id: String = _generate_automation_id()
	var clean_steps: Array = validation.get("steps", [])
	var now: int = Time.get_ticks_msec()
	var record: Dictionary = {
		"automation_id": automation_id,
		"run_id": expected_run_id,
		"session_id": int(binding.get("session_id", -1)),
		"state": "queued",
		"current_step": 0,
		"step_count": clean_steps.size(),
		"results": [],
		"failure": "",
		"started_at_ms": 0,
		"ended_at_ms": 0,
		"queued_at_ms": now,
		"last_event_at_ms": now,
		"cancel_requested": false,
		"timeout_paused_at_ms": 0,
	}
	_automations[automation_id] = record
	_automation_order.append(automation_id)
	var envelope: Dictionary = {
		"v": AUTOMATION_PROTOCOL_VERSION,
		"run_id": expected_run_id,
		"automation_id": automation_id,
		"kind": "execute",
		"steps": clean_steps.duplicate(true),
		"stop_on_failure": stop_on_failure,
	}
	session.send_message("godetx_automation:request", [envelope])
	return _automation_public_record(record)


func automation_status(expected_run_id: String, automation_id: String) -> Dictionary:
	_sync_play_state()
	_sync_automation_timeouts()
	if not RuntimeAutomationDriver.is_safe_identifier(expected_run_id):
		return _error("run_id must be a safe non-empty identifier")
	if not RuntimeAutomationDriver.is_safe_identifier(automation_id):
		return _error("automation_id must be a safe non-empty identifier")
	var record_value: Variant = _automations.get(automation_id)
	if not record_value is Dictionary:
		return _error("Runtime automation was not found")
	var record: Dictionary = record_value as Dictionary
	if str(record.get("run_id", "")) != expected_run_id:
		return _error("automation_id does not belong to the requested run")
	return _automation_public_record(record)


func automation_cancel(expected_run_id: String, automation_id: String) -> Dictionary:
	_sync_play_state()
	_sync_automation_timeouts()
	if not RuntimeAutomationDriver.is_safe_identifier(automation_id):
		return _error("automation_id must be a safe non-empty identifier")
	var record_value: Variant = _automations.get(automation_id)
	if not record_value is Dictionary:
		return _error("Runtime automation was not found")
	var record: Dictionary = record_value as Dictionary
	if str(record.get("run_id", "")) != expected_run_id:
		return _error("automation_id does not belong to the requested run")
	if not _is_active_automation_state(str(record.get("state", ""))):
		return _automation_public_record(record)
	var ownership: Dictionary = _validate_automation_ownership(expected_run_id)
	if not bool(ownership.get("ok", false)):
		return ownership
	var binding: Dictionary = _owned_probe_session_binding(true)
	if not bool(binding.get("ok", false)):
		return binding
	if int(binding.get("session_id", -1)) != int(record.get("session_id", -2)):
		return _error("The runtime automation debugger session changed")
	var session_value: Variant = binding.get("session")
	if not session_value is EditorDebuggerSession:
		return _error("The owned debugger session is unavailable")
	record["cancel_requested"] = true
	_automations[automation_id] = record
	(session_value as EditorDebuggerSession).send_message(
		"godetx_automation:request",
		[{
			"v": AUTOMATION_PROTOCOL_VERSION,
			"run_id": expected_run_id,
			"automation_id": automation_id,
			"kind": "cancel",
		}]
	)
	return _automation_public_record(record)


func capture_screenshot(
	expected_run_id: String,
	max_dimension: int,
	callback: Callable
) -> Dictionary:
	_sync_play_state()
	var ownership: Dictionary = _validate_automation_ownership(expected_run_id)
	if not bool(ownership.get("ok", false)):
		return ownership
	if max_dimension < MIN_VISUAL_DIMENSION or max_dimension > MAX_VISUAL_DIMENSION:
		return _error("max_dimension must be from %d to %d" % [
			MIN_VISUAL_DIMENSION,
			MAX_VISUAL_DIMENSION,
		])
	if not callback.is_valid():
		return _error("A screenshot completion callback is required")
	if _visual_captures.size() >= MAX_PENDING_VISUAL_CAPTURES:
		return _error("Too many game screenshot requests are pending")
	var binding: Dictionary = _owned_probe_session_binding()
	if not bool(binding.get("ok", false)):
		return binding
	var session_value: Variant = binding.get("session")
	if not session_value is EditorDebuggerSession:
		return _error("The owned debugger session is unavailable")
	var capture_id := _generate_capture_id()
	var record := {
		"capture_id": capture_id,
		"run_id": expected_run_id,
		"session_id": int(binding.get("session_id", -1)),
		"max_dimension": max_dimension,
		"requested_at_ms": Time.get_ticks_msec(),
	}
	_visual_captures[capture_id] = record
	_visual_callbacks[capture_id] = callback
	(session_value as EditorDebuggerSession).send_message(
		"godetx_visual:request",
		[{
			"v": VISUAL_PROTOCOL_VERSION,
			"run_id": expected_run_id,
			"capture_id": capture_id,
			"max_dimension": max_dimension,
		}]
	)
	return {
		"ok": true,
		"pending": true,
		"run_id": expected_run_id,
		"capture_id": capture_id,
	}


func cancel_screenshot(capture_id: String, reason: String) -> bool:
	if not _visual_captures.has(capture_id):
		return false
	_complete_visual_capture(capture_id, _error(reason))
	return true


func _has_capture(capture: String) -> bool:
	return (
		capture == "godetx_debug"
		or capture == "godetx_automation"
		or capture == "godetx_visual"
	)


func _capture(message: String, data: Array, session_id: int) -> bool:
	match message:
		"godetx_debug:hello":
			_capture_hello(data, session_id)
			return true
		"godetx_debug:log_batch":
			_capture_log_batch(data, session_id)
			return true
		"godetx_automation:event":
			_capture_automation_event(data, session_id)
			return true
		"godetx_visual:screenshot":
			_capture_visual_screenshot(data, session_id)
			return true
		_:
			return false


func _setup_session(session_id: int) -> void:
	var session: EditorDebuggerSession = get_session(session_id)
	if session == null:
		return
	_session_refs[session_id] = session
	var state: Dictionary = _session_state(session_id)
	state["active"] = session.is_active()
	state["breaked"] = session.is_breaked()
	state["debuggable"] = session.is_debuggable()
	_sessions[session_id] = state
	session.started.connect(_on_session_started.bind(session_id))
	session.stopped.connect(_on_session_stopped.bind(session_id))
	session.breaked.connect(_on_session_breaked.bind(session_id))
	session.continued.connect(_on_session_continued.bind(session_id))


func _capture_hello(data: Array, session_id: int) -> void:
	if data.size() < 2 or not data[0] is String or not data[1] is int:
		return
	var received_run_id: String = data[0]
	var protocol_version: int = data[1]
	if received_run_id != _run_id or not _owned:
		return
	var state: Dictionary = _session_state(session_id)
	var hello_seen: bool = bool(state.get("hello_seen", false))
	var previous_version: int = int(state.get("protocol_version", -1))
	var now: int = Time.get_ticks_msec()
	var supported: bool = protocol_version == SUPPORTED_PROTOCOL_VERSION
	state["active"] = true
	state["run_id"] = _run_id
	state["hello_seen"] = true
	state["protocol_version"] = protocol_version
	state["probe_confirmed"] = supported
	if supported:
		state["last_probe_at_ms"] = now
		if _owned_session_id < 0:
			_owned_session_id = session_id
	_sessions[session_id] = state
	_launch_observed = true
	_probe_confirmed = _probe_confirmed or supported
	if not hello_seen or previous_version != protocol_version:
		_append_lifecycle("probe_connected", {
			"session_id": session_id,
			"protocol_version": protocol_version,
			"supported": supported,
		})


func _capture_log_batch(data: Array, session_id: int) -> void:
	if (
		data.size() < 3
		or not data[0] is String
		or not data[1] is Array
		or not data[2] is int
	):
		return
	var dropped: int = clampi(int(data[2]), 0, MAX_REPORTED_DROPPED)
	var received_run_id: String = data[0]
	var received_entries: Array = data[1]
	_ingest_log_batch(received_run_id, received_entries, dropped, session_id)


func _capture_automation_event(data: Array, session_id: int) -> void:
	if data.size() != 1 or not data[0] is Dictionary:
		return
	_ingest_automation_event(data[0] as Dictionary, session_id)


func _capture_visual_screenshot(data: Array, session_id: int) -> void:
	if data.size() != 2 or not data[0] is Dictionary or not data[1] is PackedByteArray:
		return
	var metadata: Dictionary = data[0] as Dictionary
	var capture_id := str(metadata.get("capture_id", ""))
	var record_value: Variant = _visual_captures.get(capture_id)
	if not record_value is Dictionary:
		return
	var record: Dictionary = record_value as Dictionary
	if (
		not metadata.get("v") is int
		or int(metadata.get("v")) != VISUAL_PROTOCOL_VERSION
		or str(metadata.get("run_id", "")) != str(record.get("run_id", ""))
		or int(record.get("session_id", -1)) != session_id
	):
		_complete_visual_capture(capture_id, _error("Ignored a screenshot from a different game run or debugger session"))
		return
	if not bool(metadata.get("ok", false)):
		_complete_visual_capture(
			capture_id,
			_error(str(metadata.get("error", "The running game screenshot failed")))
		)
		return
	var encoded: PackedByteArray = data[1] as PackedByteArray
	if encoded.is_empty() or encoded.size() > MAX_VISUAL_BYTES:
		_complete_visual_capture(capture_id, _error("The running game screenshot has an invalid size"))
		return
	var image := Image.new()
	var decode_error := image.load_png_from_buffer(encoded)
	if decode_error != OK or image.is_empty():
		_complete_visual_capture(capture_id, _error("The running game returned an invalid PNG screenshot"))
		return
	if (
		image.get_width() != int(metadata.get("width", -1))
		or image.get_height() != int(metadata.get("height", -1))
		or image.get_width() > int(record.get("max_dimension", MAX_VISUAL_DIMENSION))
		or image.get_height() > int(record.get("max_dimension", MAX_VISUAL_DIMENSION))
	):
		_complete_visual_capture(capture_id, _error("The running game screenshot dimensions do not match its request"))
		return
	var stored: Dictionary = _attachment_store.import_image(
		image,
		"game_frame",
		"Running game frame.png",
		"high",
		{
			"run_id": str(record.get("run_id", "")),
			"scene_path": str(metadata.get("scene_path", "")),
			"captured_at_ms": int(metadata.get("captured_at_ms", 0)),
			"viewport_width": int(metadata.get("viewport_width", 0)),
			"viewport_height": int(metadata.get("viewport_height", 0)),
			"frame": int(metadata.get("frame", 0)),
		}
	)
	if not bool(stored.get("ok", false)):
		_complete_visual_capture(capture_id, stored)
		return
	var attachment_value: Variant = stored.get("attachment")
	if not attachment_value is Dictionary:
		_complete_visual_capture(capture_id, _error("The running game screenshot was not stored"))
		return
	var result: Dictionary = AttachmentStore.metadata_reference(attachment_value as Dictionary)
	result["ok"] = true
	result["capture_id"] = capture_id
	_complete_visual_capture(capture_id, result)


func _complete_visual_capture(capture_id: String, result: Dictionary) -> void:
	var callback_value: Variant = _visual_callbacks.get(capture_id)
	_visual_callbacks.erase(capture_id)
	_visual_captures.erase(capture_id)
	if callback_value is Callable and (callback_value as Callable).is_valid():
		(callback_value as Callable).call_deferred(result.duplicate(true))


func _fail_visual_captures(failure: String, session_id: int = -1) -> void:
	var capture_ids: Array = _visual_captures.keys()
	for capture_id_value in capture_ids:
		var capture_id := str(capture_id_value)
		var record_value: Variant = _visual_captures.get(capture_id)
		if not record_value is Dictionary:
			continue
		if session_id >= 0 and int((record_value as Dictionary).get("session_id", -1)) != session_id:
			continue
		_complete_visual_capture(capture_id, _error(failure))


func _ingest_automation_event(event: Dictionary, session_id: int) -> Dictionary:
	if JSON.stringify(event).to_utf8_buffer().size() > RuntimeAutomationDriver.MAX_PLAN_BYTES:
		return _error("Ignored an oversized runtime automation event")
	var version_value: Variant = event.get("v")
	var run_id_value: Variant = event.get("run_id")
	var automation_id_value: Variant = event.get("automation_id")
	var state_value: Variant = event.get("state")
	if (
		not version_value is int
		or int(version_value) != AUTOMATION_PROTOCOL_VERSION
		or not run_id_value is String
		or not automation_id_value is String
		or not state_value is String
	):
		return _error("Ignored a malformed runtime automation event")
	var run_id: String = run_id_value
	var automation_id: String = automation_id_value
	var state: String = state_value
	if run_id != _run_id or not _owned:
		return _error("Ignored an automation event for a run GodotX does not own")
	if state != "running" and state != "passed" and state != "failed" and state != "cancelled":
		return _error("Ignored an automation event with an invalid state")
	var record_value: Variant = _automations.get(automation_id)
	if not record_value is Dictionary:
		return _error("Ignored an automation event with an unknown automation_id")
	var record: Dictionary = record_value as Dictionary
	if (
		str(record.get("run_id", "")) != run_id
		or int(record.get("session_id", -1)) != session_id
	):
		return _error("Ignored an automation event from a different debugger session")
	if not _is_active_automation_state(str(record.get("state", ""))):
		return _error("Ignored an automation event after the plan reached a terminal state")
	var current_step_value: Variant = event.get("current_step")
	var step_count_value: Variant = event.get("step_count")
	var results_value: Variant = event.get("results")
	if (
		not current_step_value is int
		or not step_count_value is int
		or not results_value is Array
	):
		return _error("Ignored a malformed runtime automation status")
	var expected_step_count: int = int(record.get("step_count", 0))
	var current_step: int = int(current_step_value)
	var previous_step: int = int(record.get("current_step", 0))
	if (
		int(step_count_value) != expected_step_count
		or current_step < 0
		or current_step > expected_step_count
		or current_step < previous_step
	):
		return _error("Ignored an automation status with inconsistent progress")
	if state == "passed" and current_step != expected_step_count:
		return _error("Ignored an incomplete passed automation status")
	var clean_results: Dictionary = _sanitize_automation_results(
		results_value as Array,
		expected_step_count,
		current_step
	)
	if not bool(clean_results.get("ok", false)):
		return clean_results
	var started_value: Variant = event.get("started_at_ms", 0)
	var ended_value: Variant = event.get("ended_at_ms", 0)
	if not started_value is int or not ended_value is int:
		return _error("Ignored automation status with invalid timestamps")
	var failure: String = ""
	if event.has("failure"):
		if not event.get("failure") is String:
			return _error("Ignored automation status with an invalid failure message")
		failure = _limited(str(event.get("failure", "")), MAX_TEXT_CHARS)
	if state == "failed" and failure.is_empty():
		failure = "Runtime automation failed"
	var now: int = Time.get_ticks_msec()
	record["state"] = state
	record["current_step"] = current_step
	record["results"] = (clean_results.get("results", []) as Array).duplicate(true)
	record["failure"] = failure
	record["started_at_ms"] = maxi(0, int(started_value))
	record["ended_at_ms"] = maxi(0, int(ended_value))
	record["last_event_at_ms"] = now
	if record["started_at_ms"] == 0:
		record["started_at_ms"] = now
	if state != "running" and int(record.get("ended_at_ms", 0)) == 0:
		record["ended_at_ms"] = now
	_automations[automation_id] = record
	return {"ok": true, "state": state}


func _ingest_log_batch(
	received_run_id: String,
	batch_entries: Array,
	dropped: int,
	session_id: int = -1
) -> Dictionary:
	if received_run_id != _run_id or not _owned:
		return _error("Ignored a log batch for a run GodotX does not own")
	if session_id >= 0:
		var state: Dictionary = _session_state(session_id)
		if (
			str(state.get("run_id", "")) != _run_id
			or not bool(state.get("probe_confirmed", false))
		):
			return _error("Ignored a log batch before a supported runtime probe handshake")
		state["active"] = true
		_sessions[session_id] = state
		_launch_observed = true
	var accepted: int = 0
	var used_bytes: int = 0
	var accepted_limit: int = mini(batch_entries.size(), MAX_CAPTURE_BATCH_ENTRIES)
	for entry_index in range(accepted_limit):
		var value: Variant = batch_entries[entry_index]
		if not value is Dictionary:
			dropped += 1
			continue
		var clean: Dictionary = _sanitize_runtime_entry(value as Dictionary, session_id)
		if clean.is_empty():
			dropped += 1
			continue
		var clean_bytes: int = JSON.stringify(clean).to_utf8_buffer().size()
		if clean_bytes > MAX_CAPTURE_BATCH_BYTES:
			clean = _compact_runtime_entry(clean)
			clean_bytes = JSON.stringify(clean).to_utf8_buffer().size()
		if used_bytes + clean_bytes > MAX_CAPTURE_BATCH_BYTES:
			dropped += accepted_limit - entry_index
			break
		_append_entry(clean)
		used_bytes += clean_bytes
		accepted += 1
	if batch_entries.size() > accepted_limit:
		dropped += batch_entries.size() - accepted_limit
	dropped = clampi(dropped, 0, MAX_REPORTED_DROPPED)
	if dropped > 0:
		_runtime_dropped_entries = mini(
			MAX_REPORTED_DROPPED,
			_runtime_dropped_entries + dropped
		)
		_append_entry({
			"kind": "transport",
			"level": "warning",
			"text": "Runtime log queue dropped %d entries" % dropped,
			"dropped": dropped,
			"session_id": session_id,
			"timestamp_ms": Time.get_ticks_msec(),
		})
	return {"ok": true, "accepted": accepted, "dropped": dropped}


func _validate_automation_ownership(expected_run_id: String) -> Dictionary:
	if not RuntimeAutomationDriver.is_safe_identifier(expected_run_id):
		return _error("run_id must be a safe non-empty identifier")
	if expected_run_id != _run_id:
		return _error("run_id does not match the active GodotX run")
	if not _owned or not _probe_confirmed:
		return _error("GodotX cannot prove ownership of the running game")
	return {"ok": true}


func _owned_probe_session_binding(allow_breaked: bool = false) -> Dictionary:
	return _owned_session_binding(true, allow_breaked)


func _owned_session_binding(require_fresh_probe: bool, allow_breaked: bool = false) -> Dictionary:
	if _owned_session_id < 0:
		return _error("The launched game's debugger session is not established")
	var state: Dictionary = _session_state(_owned_session_id)
	var now: int = Time.get_ticks_msec()
	if not _session_proves_owned_binding(_owned_session_id, state, allow_breaked):
		return _error("The launched game's debugger session is not automation-ready")
	if (
		require_fresh_probe
		and not _probe_is_fresh(state, now)
		and not bool(state.get("breaked", false))
	):
		return _error("The launched game's runtime probe is stale")
	var session_value: Variant = _session_refs.get(_owned_session_id)
	if not session_value is EditorDebuggerSession:
		return _error("No active debugger session is bound to the owned GodotX run")
	var selected_session: EditorDebuggerSession = session_value as EditorDebuggerSession
	if not is_instance_valid(selected_session) or not selected_session.is_active():
		return _error("The launched game's debugger session is inactive")
	return {
		"ok": true,
		"session_id": _owned_session_id,
		"session": selected_session,
	}


func _session_proves_owned_binding(
	session_id: int,
	state: Dictionary,
	allow_breaked: bool = false
) -> bool:
	return (
		_owned
		and session_id == _owned_session_id
		and not _run_id.is_empty()
		and str(state.get("run_id", "")) == _run_id
		and bool(state.get("probe_confirmed", false))
		and (allow_breaked or not bool(state.get("breaked", false)))
	)


func _probe_is_fresh(state: Dictionary, now: int = -1) -> bool:
	var checked_at: int = Time.get_ticks_msec() if now < 0 else now
	var last_probe_at: int = int(state.get("last_probe_at_ms", 0))
	return last_probe_at > 0 and checked_at - last_probe_at <= PROBE_STALE_AFTER_MS


func _sanitize_automation_results(
	values: Array,
	step_count: int,
	current_step: int
) -> Dictionary:
	if values.size() > RuntimeAutomationDriver.MAX_STEPS or values.size() != current_step:
		return _error("Ignored an automation status with too many step results")
	var clean: Array[Dictionary] = []
	var seen_indices: Dictionary = {}
	for result_position in range(values.size()):
		var value: Variant = values[result_position]
		if not value is Dictionary:
			return _error("Ignored a malformed automation step result")
		var result: Dictionary = value as Dictionary
		var index_value: Variant = result.get("index")
		var type_value: Variant = result.get("type")
		var state_value: Variant = result.get("state")
		var message_value: Variant = result.get("message")
		if (
			not index_value is int
			or not type_value is String
			or not state_value is String
			or not message_value is String
		):
			return _error("Ignored a malformed automation step result")
		var index: int = int(index_value)
		var result_state: String = state_value
		if (
			index < 0
			or index >= step_count
			or index >= current_step
			or index != result_position
			or seen_indices.has(index)
			or result_state != "passed" and result_state != "failed"
		):
			return _error("Ignored an inconsistent automation step result")
		seen_indices[index] = true
		clean.append({
			"index": index,
			"type": _limited(type_value as String, 64),
			"state": result_state,
			"message": _limited(message_value as String, MAX_CONTEXT_CHARS),
		})
	return {"ok": true, "results": clean}


func _automation_public_record(record: Dictionary) -> Dictionary:
	var output: Dictionary = {
		"ok": true,
		"automation_id": str(record.get("automation_id", "")),
		"run_id": str(record.get("run_id", "")),
		"state": str(record.get("state", "failed")),
		"current_step": int(record.get("current_step", 0)),
		"step_count": int(record.get("step_count", 0)),
		"results": (record.get("results", []) as Array).duplicate(true),
		"started_at_ms": int(record.get("started_at_ms", 0)),
		"ended_at_ms": int(record.get("ended_at_ms", 0)),
		"cancel_requested": bool(record.get("cancel_requested", false)),
	}
	var failure: String = str(record.get("failure", ""))
	if not failure.is_empty():
		output["failure"] = failure
	return output


func _ensure_automation_capacity() -> bool:
	while _automation_order.size() >= MAX_AUTOMATION_RECORDS:
		var removable: String = ""
		for automation_id in _automation_order:
			var value: Variant = _automations.get(automation_id)
			if not value is Dictionary or not _is_active_automation_state(
				str((value as Dictionary).get("state", ""))
			):
				removable = automation_id
				break
		if removable.is_empty():
			return false
		_automation_order.erase(removable)
		_automations.erase(removable)
	return true


func _sync_automation_timeouts() -> void:
	var now: int = Time.get_ticks_msec()
	for automation_id in _automation_order:
		var value: Variant = _automations.get(automation_id)
		if not value is Dictionary:
			continue
		var record: Dictionary = value as Dictionary
		var state: String = str(record.get("state", ""))
		var session_state: Dictionary = _session_state(int(record.get("session_id", -1)))
		if (
			state == "queued"
			and not bool(session_state.get("breaked", false))
			and now - int(record.get("queued_at_ms", now)) > AUTOMATION_QUEUE_TIMEOUT_MS
		):
			_fail_automation_record(
				automation_id,
				"The running game did not acknowledge the automation request"
			)
		elif state == "running":
			var last_event_at: int = int(record.get("last_event_at_ms", now))
			if (
				not bool(session_state.get("breaked", false))
				and now - last_event_at > AUTOMATION_ACTIVE_TIMEOUT_MS
			):
				_fail_automation_record(automation_id, "Runtime automation timed out")


func _fail_automation_record(automation_id: String, failure: String) -> void:
	var value: Variant = _automations.get(automation_id)
	if not value is Dictionary:
		return
	var record: Dictionary = value as Dictionary
	if not _is_active_automation_state(str(record.get("state", ""))):
		return
	record["state"] = "failed"
	record["failure"] = _limited(failure, MAX_TEXT_CHARS)
	record["ended_at_ms"] = Time.get_ticks_msec()
	_automations[automation_id] = record


func _fail_active_automations(failure: String, session_id: int = -1) -> void:
	for automation_id in _automation_order:
		var value: Variant = _automations.get(automation_id)
		if not value is Dictionary:
			continue
		var record: Dictionary = value as Dictionary
		if session_id >= 0 and int(record.get("session_id", -1)) != session_id:
			continue
		if _is_active_automation_state(str(record.get("state", ""))):
			_fail_automation_record(automation_id, failure)


func _pause_automation_timeouts(session_id: int) -> void:
	var now: int = Time.get_ticks_msec()
	for automation_id in _automation_order:
		var value: Variant = _automations.get(automation_id)
		if not value is Dictionary:
			continue
		var record: Dictionary = value as Dictionary
		if (
			int(record.get("session_id", -1)) == session_id
			and _is_active_automation_state(str(record.get("state", "")))
			and int(record.get("timeout_paused_at_ms", 0)) == 0
		):
			record["timeout_paused_at_ms"] = now
			_automations[automation_id] = record


func _resume_automation_timeouts(session_id: int) -> void:
	var now: int = Time.get_ticks_msec()
	for automation_id in _automation_order:
		var value: Variant = _automations.get(automation_id)
		if not value is Dictionary:
			continue
		var record: Dictionary = value as Dictionary
		if int(record.get("session_id", -1)) != session_id:
			continue
		var paused_at: int = int(record.get("timeout_paused_at_ms", 0))
		if paused_at <= 0:
			continue
		var paused_duration: int = maxi(0, now - paused_at)
		record["queued_at_ms"] = int(record.get("queued_at_ms", now)) + paused_duration
		record["last_event_at_ms"] = int(record.get("last_event_at_ms", now)) + paused_duration
		record["timeout_paused_at_ms"] = 0
		_automations[automation_id] = record


func _is_active_automation_state(state: String) -> bool:
	return state == "queued" or state == "running"


func _on_session_started(session_id: int) -> void:
	var state: Dictionary = _session_state(session_id)
	state["active"] = true
	state["breaked"] = false
	state["started_at_ms"] = Time.get_ticks_msec()
	if _owned:
		_launch_observed = true
	_sessions[session_id] = state
	_append_lifecycle("session_started", {"session_id": session_id})


func _on_session_stopped(session_id: int) -> void:
	var state: Dictionary = _session_state(session_id)
	var stopped_run_id: String = str(state.get("run_id", ""))
	state["active"] = false
	state["breaked"] = false
	state["stopped_at_ms"] = Time.get_ticks_msec()
	_sessions[session_id] = state
	_append_lifecycle("session_stopped", {"session_id": session_id})
	_fail_active_automations("The debugger session stopped during automation", session_id)
	_fail_visual_captures("The debugger session stopped before the screenshot completed", session_id)
	if session_id == _owned_session_id and stopped_run_id == _run_id:
		_finish_owned_run()


func _on_session_breaked(can_debug: bool, session_id: int) -> void:
	var state: Dictionary = _session_state(session_id)
	state["active"] = true
	state["breaked"] = true
	state["can_debug"] = can_debug
	_sessions[session_id] = state
	_pause_automation_timeouts(session_id)
	_append_lifecycle("session_breaked", {
		"session_id": session_id,
		"can_debug": can_debug,
	})


func _on_session_continued(session_id: int) -> void:
	var state: Dictionary = _session_state(session_id)
	state["active"] = true
	state["breaked"] = false
	_sessions[session_id] = state
	_resume_automation_timeouts(session_id)
	_append_lifecycle("session_continued", {"session_id": session_id})


func _snapshot_impl(after_seq: int, history_limit: int) -> Dictionary:
	var bounded_limit: int = clampi(history_limit, 1, 500)
	var bounded_after_seq: int = maxi(0, after_seq)
	var oldest_seq: int = _next_sequence
	if not _entries.is_empty():
		oldest_seq = int(_entries[0].get("seq", _next_sequence))
	var selected: Array[Dictionary] = []
	var has_more: bool = false
	if bounded_after_seq <= 0:
		var start_index: int = maxi(0, _entries.size() - bounded_limit)
		for index in range(start_index, _entries.size()):
			selected.append(_entries[index].duplicate(true))
	else:
		for entry in _entries:
			if int(entry.get("seq", 0)) <= bounded_after_seq:
				continue
			if selected.size() >= bounded_limit:
				has_more = true
				break
			selected.append(entry.duplicate(true))
	var latest_seq: int = _next_sequence - 1
	var next_seq: int = mini(bounded_after_seq, latest_seq)
	if not selected.is_empty():
		next_seq = int(selected.back().get("seq", next_seq))

	var session_list: Array[Dictionary] = []
	var session_ids: Array[int] = []
	for key in _sessions.keys():
		session_ids.append(int(key))
	session_ids.sort()
	for session_id in session_ids:
		session_list.append((_sessions[session_id] as Dictionary).duplicate(true))

	var playing: bool = editor_interface != null and editor_interface.is_playing_scene()
	var playing_scene: String = ""
	if playing:
		playing_scene = _normalize_scene_path(editor_interface.get_playing_scene())
	var displayed_scene: String = playing_scene if not playing_scene.is_empty() else _requested_scene_path
	var breaked: bool = _any_owned_session_breaked()
	return {
		"ok": true,
		"run_id": _run_id,
		"mode": _run_mode,
		"requested_scene_path": _requested_scene_path,
		"playing_scene_path": playing_scene,
		"scene_path": displayed_scene,
		"armed": _armed,
		"owned": _owned,
		"playing": playing,
		"launch_observed": _launch_observed,
		"probe_confirmed": _probe_confirmed,
		"probe_active": _owned and _probe_confirmed,
		"runtime_probe_available": runtime_probe_available,
		"runtime_probe_error": runtime_probe_error,
		"stop_requested": _stop_requested,
		"breaked": breaked,
		"paused": breaked,
		"started_at_ms": _started_at_ms,
		"ended_at_ms": _ended_at_ms,
		"elapsed_ms": _elapsed_ms(),
		"sessions": session_list,
		"entries": selected,
		"oldest_seq": oldest_seq,
		"latest_seq": latest_seq,
		"next_seq": next_seq,
		"has_more": has_more,
		"truncated": bounded_after_seq > 0 and bounded_after_seq < oldest_seq - 1,
		"discarded_entries": _discarded_entries,
		"dropped_count": _runtime_dropped_entries,
	}


func _sync_play_state() -> void:
	var now: int = Time.get_ticks_msec()
	if _armed and now - _armed_at_ms > ARM_TIMEOUT_MS:
		_armed = false
		_ended_at_ms = now
		_append_lifecycle("launch_timeout")
	if not _owned or editor_interface == null:
		return
	if not _launch_observed:
		if (
			_started_at_ms > 0
			and now - _started_at_ms >= LAUNCH_OBSERVE_GRACE_MS
			and not editor_interface.is_playing_scene()
		):
			_append_lifecycle("launch_failed", {"reason": "No debugger session was observed"})
			_finish_owned_run()
		return
	if not editor_interface.is_playing_scene() and not _has_active_owned_session():
		_finish_owned_run()


func _finish_owned_run() -> void:
	if not _owned:
		return
	_fail_active_automations("The owned game stopped during automation")
	_fail_visual_captures("The owned game stopped before the screenshot completed")
	_owned = false
	_ended_at_ms = Time.get_ticks_msec()
	_append_lifecycle("run_stopped", {"stop_requested": _stop_requested})


func _has_active_owned_session(require_probe: bool = false) -> bool:
	if _owned_session_id < 0:
		return false
	var state: Dictionary = _session_state(_owned_session_id)
	if not _session_proves_owned_binding(_owned_session_id, state, true):
		return false
	if (
		require_probe
		and not _probe_is_fresh(state)
		and not bool(state.get("breaked", false))
	):
		return false
	var session_value: Variant = _session_refs.get(_owned_session_id)
	if not session_value is EditorDebuggerSession:
		return false
	var session: EditorDebuggerSession = session_value as EditorDebuggerSession
	return is_instance_valid(session) and session.is_active()


func _any_owned_session_breaked() -> bool:
	if _owned_session_id < 0:
		return false
	var state: Dictionary = _session_state(_owned_session_id)
	return (
		_session_proves_owned_binding(_owned_session_id, state, true)
		and bool(state.get("active", false))
		and bool(state.get("breaked", false))
	)


func _session_state(session_id: int) -> Dictionary:
	var value: Variant = _sessions.get(session_id)
	if value is Dictionary:
		return (value as Dictionary).duplicate(true)
	return {
		"session_id": session_id,
		"active": false,
		"breaked": false,
		"debuggable": false,
		"can_debug": false,
		"probe_confirmed": false,
		"hello_seen": false,
		"protocol_version": -1,
		"last_probe_at_ms": 0,
		"run_id": "",
		"started_at_ms": 0,
		"stopped_at_ms": 0,
	}


func _sanitize_runtime_entry(entry: Dictionary, session_id: int) -> Dictionary:
	if (
		not entry.get("kind") is String
		or not entry.get("level") is String
		or not entry.get("text") is String
		or not entry.get("timestamp_ms") is int
		or not entry.get("probe_seq") is int
	):
		return {}
	var kind: String = entry.kind
	var clean: Dictionary = {
		"kind": _limited(kind, 64),
		"level": _limited(_safe_string(entry.get("level")), 64),
		"text": _limited(_safe_string(entry.get("text")), MAX_TEXT_CHARS),
		"timestamp_ms": _safe_int(entry.get("timestamp_ms")),
		"probe_seq": _safe_int(entry.get("probe_seq")),
		"session_id": session_id,
	}
	if kind == "error":
		clean["function"] = _limited(_safe_string(entry.get("function")), MAX_CONTEXT_CHARS)
		clean["file"] = _limited(_safe_string(entry.get("file")), MAX_CONTEXT_CHARS)
		clean["line"] = _safe_int(entry.get("line", 0))
		clean["code"] = _limited(_safe_string(entry.get("code")), MAX_TEXT_CHARS)
		clean["rationale"] = _limited(_safe_string(entry.get("rationale")), MAX_TEXT_CHARS)
		clean["editor_notify"] = (
			entry.editor_notify if entry.get("editor_notify") is bool else false
		)
		clean["error_type"] = _safe_int(entry.get("error_type", 0))
		clean["backtraces"] = _sanitize_backtraces(entry.get("backtraces", []))
	return clean


func _compact_runtime_entry(entry: Dictionary) -> Dictionary:
	return {
		"kind": _limited(_safe_string(entry.get("kind"), "message"), 64),
		"level": _limited(_safe_string(entry.get("level"), "info"), 64),
		"text": _limited(_safe_string(entry.get("text")), 3072),
		"timestamp_ms": _safe_int(entry.get("timestamp_ms", 0)),
		"probe_seq": _safe_int(entry.get("probe_seq", 0)),
		"session_id": _safe_int(entry.get("session_id", -1), -1),
		"details_truncated": true,
	}


func _sanitize_backtraces(value) -> Array[Dictionary]:
	var clean: Array[Dictionary] = []
	if not value is Array:
		return clean
	var trace_values: Array = value as Array
	for trace_index in range(mini(trace_values.size(), MAX_BACKTRACES)):
		var trace_value: Variant = trace_values[trace_index]
		if not trace_value is Dictionary:
			continue
		var trace: Dictionary = trace_value as Dictionary
		var frames: Array[Dictionary] = []
		var frame_values: Variant = trace.get("frames", [])
		if frame_values is Array:
			for frame_index in range(mini((frame_values as Array).size(), MAX_BACKTRACE_FRAMES)):
				var frame_value: Variant = (frame_values as Array)[frame_index]
				if not frame_value is Dictionary:
					continue
				var frame: Dictionary = frame_value as Dictionary
				frames.append({
					"file": _limited(_safe_string(frame.get("file")), MAX_CONTEXT_CHARS),
					"function": _limited(_safe_string(frame.get("function")), MAX_CONTEXT_CHARS),
					"line": _safe_int(frame.get("line", 0)),
				})
		clean.append({
			"language": _limited(_safe_string(trace.get("language")), 128),
			"frames": frames,
		})
	return clean


func _append_lifecycle(event: String, details: Dictionary = {}) -> void:
	var entry: Dictionary = {
		"kind": "lifecycle",
		"level": "info",
		"event": _limited(event, 128),
		"text": _limited(event.replace("_", " "), MAX_TEXT_CHARS),
		"timestamp_ms": Time.get_ticks_msec(),
	}
	for key in details:
		entry[key] = details[key]
	_append_entry(entry)


func _append_entry(entry: Dictionary) -> void:
	var stored: Dictionary = entry.duplicate(true)
	stored["seq"] = _next_sequence
	_next_sequence += 1
	var stored_bytes: int = JSON.stringify(stored).to_utf8_buffer().size()
	if stored_bytes > MAX_RING_BYTES:
		stored = _compact_runtime_entry(stored)
		stored["seq"] = _next_sequence - 1
		stored_bytes = JSON.stringify(stored).to_utf8_buffer().size()
	_entries.append(stored)
	_entry_sizes.append(stored_bytes)
	_ring_bytes += stored_bytes
	while _entries.size() > MAX_RING_ENTRIES or _ring_bytes > MAX_RING_BYTES:
		_entries.pop_front()
		var removed_bytes: int = _entry_sizes.pop_front()
		_ring_bytes = maxi(0, _ring_bytes - removed_bytes)
		_discarded_entries += 1


func _reset_for_new_run() -> void:
	_fail_visual_captures("A new game run replaced the pending screenshot request")
	_run_id = ""
	_run_mode = ""
	_requested_scene_path = ""
	_launched_scene_path = ""
	_armed = false
	_owned = false
	_launch_observed = false
	_probe_confirmed = false
	_stop_requested = false
	_armed_at_ms = 0
	_started_at_ms = 0
	_ended_at_ms = 0
	_next_sequence = 1
	_discarded_entries = 0
	_runtime_dropped_entries = 0
	_ring_bytes = 0
	_entries.clear()
	_entry_sizes.clear()
	_sessions.clear()
	_owned_session_id = -1
	_automations.clear()
	_automation_order.clear()
	_visual_captures.clear()
	_visual_callbacks.clear()


func _elapsed_ms() -> int:
	if _started_at_ms <= 0:
		return 0
	var endpoint: int = _ended_at_ms if _ended_at_ms > 0 else Time.get_ticks_msec()
	return maxi(0, endpoint - _started_at_ms)


func _generate_run_id() -> String:
	return Crypto.new().generate_random_bytes(16).hex_encode()


func _generate_automation_id() -> String:
	return Crypto.new().generate_random_bytes(16).hex_encode()


func _generate_capture_id() -> String:
	return Crypto.new().generate_random_bytes(16).hex_encode()


func _normalize_scene_path(path: String) -> String:
	var stripped: String = path.strip_edges().replace("\\", "/")
	if stripped.is_empty():
		return ""
	return ProjectSettings.localize_path(stripped)


func _limited(value: String, limit: int) -> String:
	return value if value.length() <= limit else value.left(limit)


func _safe_int(value, fallback: int = 0) -> int:
	return int(value) if value is int else fallback


func _safe_string(value, fallback: String = "") -> String:
	if value is String:
		return value
	return fallback


func _error(message: String) -> Dictionary:
	return {"ok": false, "error": message}
