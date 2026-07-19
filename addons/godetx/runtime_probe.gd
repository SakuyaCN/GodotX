extends Node

const RuntimeAutomationDriver := preload("res://addons/godetx/runtime_automation_driver.gd")

const RUN_ARGUMENT_PREFIX := "--godetx-run-id="
const PROTOCOL_VERSION := 1
const FLUSH_INTERVAL_MS := 75
const HELLO_INTERVAL_MS := 1000
const MAX_BATCH_ENTRIES := 32
const MAX_BATCH_BYTES := 16 * 1024
const AUTOMATION_CAPTURE_NAME := &"godetx_automation"
const MAX_AUTOMATION_REQUESTS := 32
const MAX_AUTOMATION_REQUESTS_PER_FRAME := 8
const VISUAL_CAPTURE_NAME := &"godetx_visual"
const VISUAL_PROTOCOL_VERSION := 1
const MAX_VISUAL_REQUESTS := 4
const MIN_VISUAL_DIMENSION := 64
const MAX_VISUAL_DIMENSION := 2048
const MAX_VISUAL_PIXELS := 16 * 1024 * 1024
const MAX_VISUAL_BYTES := 8 * 1024 * 1024


class ProbeLogger:
	extends Logger

	const MAX_PENDING_ENTRIES := 256
	const MAX_TEXT_CHARS := 4096
	const MAX_CONTEXT_CHARS := 512
	const MAX_BACKTRACES := 2
	const MAX_BACKTRACE_FRAMES := 16
	const MAX_ENTRY_BYTES := 16 * 1024

	var _mutex: Mutex = Mutex.new()
	var _pending: Array[Dictionary] = []
	var _next_sequence: int = 1
	var _dropped_since_drain: int = 0


	func _log_message(message: String, error: bool) -> void:
		_enqueue({
			"kind": "message",
			"level": "stderr" if error else "info",
			"text": _limited(message, MAX_TEXT_CHARS),
			"timestamp_ms": Time.get_ticks_msec(),
		})


	func _log_error(
		function: String,
		file: String,
		line: int,
		code: String,
		rationale: String,
		editor_notify: bool,
		error_type: int,
		script_backtraces: Array[ScriptBacktrace]
	) -> void:
		var entry: Dictionary = {
			"kind": "error",
			"level": _error_level(error_type),
			"text": _limited(rationale if not rationale.is_empty() else code, MAX_TEXT_CHARS),
			"function": _limited(function, MAX_CONTEXT_CHARS),
			"file": _limited(file, MAX_CONTEXT_CHARS),
			"line": line,
			"code": _limited(code, MAX_TEXT_CHARS),
			"rationale": _limited(rationale, MAX_TEXT_CHARS),
			"editor_notify": editor_notify,
			"error_type": error_type,
			"timestamp_ms": Time.get_ticks_msec(),
			"backtraces": _serialize_backtraces(script_backtraces),
		}
		_enqueue(entry)


	func drain(max_entries: int, max_bytes: int) -> Dictionary:
		var entries: Array[Dictionary] = []
		var used_bytes: int = 0
		var consumed: int = 0
		_mutex.lock()
		while consumed < _pending.size() and entries.size() < max_entries:
			var candidate: Dictionary = _pending[consumed]
			var candidate_bytes: int = JSON.stringify(candidate).to_utf8_buffer().size()
			if not entries.is_empty() and used_bytes + candidate_bytes > max_bytes:
				break
			entries.append(candidate)
			consumed += 1
			used_bytes += candidate_bytes
		if consumed > 0:
			var remaining: Array[Dictionary] = []
			for index in range(consumed, _pending.size()):
				remaining.append(_pending[index])
			_pending = remaining
		var dropped: int = _dropped_since_drain
		_dropped_since_drain = 0
		_mutex.unlock()
		return {
			"entries": entries,
			"dropped": dropped,
		}


	func _compact_entry(entry: Dictionary) -> Dictionary:
		return {
			"kind": _limited(str(entry.get("kind", "message")), 64),
			"level": _limited(str(entry.get("level", "info")), 64),
			"text": _limited(str(entry.get("text", "")), 3072),
			"timestamp_ms": int(entry.get("timestamp_ms", 0)),
			"probe_seq": int(entry.get("probe_seq", 0)),
			"details_truncated": true,
		}


	func _enqueue(entry: Dictionary) -> void:
		var stored: Dictionary = entry
		if JSON.stringify(stored).to_utf8_buffer().size() > MAX_ENTRY_BYTES - 128:
			stored = _compact_entry(stored)
		_mutex.lock()
		if _pending.size() >= MAX_PENDING_ENTRIES:
			_dropped_since_drain += 1
			_mutex.unlock()
			return
		stored["probe_seq"] = _next_sequence
		_next_sequence += 1
		_pending.append(stored)
		_mutex.unlock()


	func _serialize_backtraces(backtraces: Array[ScriptBacktrace]) -> Array[Dictionary]:
		var serialized: Array[Dictionary] = []
		var trace_limit: int = mini(backtraces.size(), MAX_BACKTRACES)
		for trace_index in range(trace_limit):
			var trace: ScriptBacktrace = backtraces[trace_index]
			if trace == null:
				continue
			var frames: Array[Dictionary] = []
			var frame_limit: int = mini(trace.get_frame_count(), MAX_BACKTRACE_FRAMES)
			for frame_index in range(frame_limit):
				frames.append({
					"file": _limited(trace.get_frame_file(frame_index), MAX_CONTEXT_CHARS),
					"function": _limited(trace.get_frame_function(frame_index), MAX_CONTEXT_CHARS),
					"line": trace.get_frame_line(frame_index),
				})
			serialized.append({
				"language": _limited(trace.get_language_name(), 128),
				"frames": frames,
			})
		return serialized


	func _error_level(error_type: int) -> String:
		match error_type:
			1:
				return "warning"
			2:
				return "script_error"
			3:
				return "shader_error"
			_:
				return "error"


	func _limited(value: String, limit: int) -> String:
		return value if value.length() <= limit else value.left(limit)


var _run_id: String = ""
var _logger: ProbeLogger
var _next_flush_at_ms: int = 0
var _next_hello_at_ms: int = 0
var _hello_sent: bool = false
var _automation_driver: RefCounted
var _pending_automation_requests: Array[Dictionary] = []
var _owns_automation_capture: bool = false
var _pending_visual_requests: Array[Dictionary] = []
var _owns_visual_capture: bool = false
var _visual_capture_scheduled: bool = false


func _enter_tree() -> void:
	_run_id = _read_run_id(OS.get_cmdline_user_args())
	if _run_id.is_empty():
		set_process(false)
		set_physics_process(false)
		return
	process_mode = Node.PROCESS_MODE_ALWAYS
	_logger = ProbeLogger.new()
	_automation_driver = RuntimeAutomationDriver.new(
		get_tree(),
		_run_id,
		_send_automation_event
	)
	OS.add_logger(_logger)
	var now: int = Time.get_ticks_msec()
	_next_flush_at_ms = now
	_next_hello_at_ms = now
	set_process(true)
	set_physics_process(true)


func _exit_tree() -> void:
	if _automation_driver != null:
		_automation_driver.call("shutdown")
		_automation_driver = null
	_pending_automation_requests.clear()
	_unregister_automation_capture()
	_pending_visual_requests.clear()
	_unregister_visual_capture()
	if _logger != null:
		var exiting_logger: ProbeLogger = _logger
		OS.remove_logger(exiting_logger)
		_logger = null
		if EngineDebugger.is_active():
			_send_hello_if_needed()
			_flush_logger(exiting_logger)


func _process(_delta: float) -> void:
	if _logger == null:
		return
	if not EngineDebugger.is_active():
		if _automation_driver != null and bool(_automation_driver.call("has_active_plan")):
			_automation_driver.call("shutdown")
		return
	_ensure_automation_capture()
	_ensure_visual_capture()
	_process_automation_requests()
	_process_visual_requests()
	if _automation_driver != null:
		_automation_driver.call("process_frame")
	var now: int = Time.get_ticks_msec()
	if not _hello_sent or now >= _next_hello_at_ms:
		_send_hello()
		_next_hello_at_ms = now + HELLO_INTERVAL_MS
	if now >= _next_flush_at_ms:
		_flush_pending()
		_next_flush_at_ms = now + FLUSH_INTERVAL_MS


func _physics_process(_delta: float) -> void:
	if (
		_logger != null
		and EngineDebugger.is_active()
		and _automation_driver != null
	):
		_automation_driver.call("process_physics_frame")


func _send_hello_if_needed() -> void:
	if _hello_sent:
		return
	_send_hello()


func _send_hello() -> void:
	EngineDebugger.send_message(
		&"godetx_debug:hello",
		[_run_id, PROTOCOL_VERSION, Time.get_ticks_msec()]
	)
	_hello_sent = true


func _flush_pending() -> void:
	if _logger != null:
		_flush_logger(_logger)


func _flush_logger(logger: ProbeLogger) -> void:
	var batch: Dictionary = logger.drain(MAX_BATCH_ENTRIES, MAX_BATCH_BYTES)
	var entries_value: Variant = batch.get("entries", [])
	var dropped: int = int(batch.get("dropped", 0))
	if entries_value is Array and (entries_value as Array).is_empty() and dropped <= 0:
		return
	EngineDebugger.send_message(
		&"godetx_debug:log_batch",
		[_run_id, entries_value, dropped]
	)


func _ensure_automation_capture() -> void:
	if _owns_automation_capture or not EngineDebugger.is_active():
		return
	if EngineDebugger.has_capture(AUTOMATION_CAPTURE_NAME):
		return
	EngineDebugger.register_message_capture(
		AUTOMATION_CAPTURE_NAME,
		_capture_automation_message
	)
	_owns_automation_capture = true


func _unregister_automation_capture() -> void:
	if not _owns_automation_capture:
		return
	if EngineDebugger.has_capture(AUTOMATION_CAPTURE_NAME):
		EngineDebugger.unregister_message_capture(AUTOMATION_CAPTURE_NAME)
	_owns_automation_capture = false


func _ensure_visual_capture() -> void:
	if _owns_visual_capture or not EngineDebugger.is_active():
		return
	if EngineDebugger.has_capture(VISUAL_CAPTURE_NAME):
		return
	EngineDebugger.register_message_capture(
		VISUAL_CAPTURE_NAME,
		_capture_visual_message
	)
	_owns_visual_capture = true


func _unregister_visual_capture() -> void:
	if not _owns_visual_capture:
		return
	if EngineDebugger.has_capture(VISUAL_CAPTURE_NAME):
		EngineDebugger.unregister_message_capture(VISUAL_CAPTURE_NAME)
	_owns_visual_capture = false


func _capture_automation_message(message: String, data: Array) -> bool:
	if message != "request":
		return false
	var validation: Dictionary = _validate_automation_envelope(data, _run_id)
	var queued: Dictionary
	if bool(validation.get("ok", false)):
		queued = (validation.get("envelope", {}) as Dictionary).duplicate(true)
	elif bool(validation.get("rejectable", false)):
		queued = {
			"kind": "reject",
			"automation_id": str(validation.get("automation_id", "")),
			"error": str(validation.get("error", "Invalid automation request")),
			"step_count": int(validation.get("step_count", 0)),
		}
	else:
		return true
	if _pending_automation_requests.size() >= MAX_AUTOMATION_REQUESTS:
		return true
	_pending_automation_requests.append(queued)
	return true


func _capture_visual_message(message: String, data: Array) -> bool:
	if message != "request":
		return false
	var validation: Dictionary = _validate_visual_envelope(data, _run_id)
	if not bool(validation.get("ok", false)):
		var capture_id := str(validation.get("capture_id", ""))
		if not capture_id.is_empty():
			_send_visual_error(capture_id, str(validation.get("error", "Invalid screenshot request")))
		return true
	if _pending_visual_requests.size() >= MAX_VISUAL_REQUESTS:
		var rejected: Dictionary = validation.get("request", {})
		_send_visual_error(str(rejected.get("capture_id", "")), "The screenshot request queue is full")
		return true
	_pending_visual_requests.append((validation.get("request", {}) as Dictionary).duplicate(true))
	return true


func _process_automation_requests() -> void:
	if _automation_driver == null:
		_pending_automation_requests.clear()
		return
	var processed: int = 0
	while not _pending_automation_requests.is_empty() and processed < MAX_AUTOMATION_REQUESTS_PER_FRAME:
		var request: Dictionary = _pending_automation_requests.pop_front()
		processed += 1
		match str(request.get("kind", "")):
			"execute":
				_automation_driver.call("execute", request)
			"cancel":
				_automation_driver.call("cancel", str(request.get("automation_id", "")))
			"reject":
				_automation_driver.call(
					"reject",
					str(request.get("automation_id", "")),
					str(request.get("error", "Invalid automation request")),
					int(request.get("step_count", 0))
				)


func _process_visual_requests() -> void:
	if _visual_capture_scheduled or _pending_visual_requests.is_empty():
		return
	var request: Dictionary = _pending_visual_requests.pop_front()
	_visual_capture_scheduled = true
	RenderingServer.frame_post_draw.connect(
		_complete_visual_capture.bind(request),
		CONNECT_ONE_SHOT
	)


func _complete_visual_capture(request: Dictionary) -> void:
	_visual_capture_scheduled = false
	var capture_id := str(request.get("capture_id", ""))
	if not EngineDebugger.is_active():
		return
	var tree := get_tree()
	if tree == null or tree.root == null:
		_send_visual_error(capture_id, "The running game viewport is unavailable")
		return
	var viewport: Viewport = tree.root
	var viewport_size := viewport.get_visible_rect().size
	var texture := viewport.get_texture()
	if texture == null:
		_send_visual_error(capture_id, "The running game viewport texture is unavailable")
		return
	var image := texture.get_image()
	if image == null or image.is_empty():
		_send_visual_error(capture_id, "The running game screenshot is empty")
		return
	if image.get_width() * image.get_height() > MAX_VISUAL_PIXELS:
		var source_scale := sqrt(float(MAX_VISUAL_PIXELS) / float(image.get_width() * image.get_height()))
		image.resize(
			maxi(1, int(floor(float(image.get_width()) * source_scale))),
			maxi(1, int(floor(float(image.get_height()) * source_scale))),
			Image.INTERPOLATE_LANCZOS
		)
	var max_dimension := int(request.get("max_dimension", MAX_VISUAL_DIMENSION))
	var longest_edge := maxi(image.get_width(), image.get_height())
	if longest_edge > max_dimension:
		var scale := float(max_dimension) / float(longest_edge)
		image.resize(
			maxi(1, int(round(float(image.get_width()) * scale))),
			maxi(1, int(round(float(image.get_height()) * scale))),
			Image.INTERPOLATE_LANCZOS
		)
	if image.get_format() != Image.FORMAT_RGBA8:
		image.convert(Image.FORMAT_RGBA8)
	var encoded := image.save_png_to_buffer()
	while encoded.size() > MAX_VISUAL_BYTES and maxi(image.get_width(), image.get_height()) > 320:
		image.resize(
			maxi(1, int(floor(float(image.get_width()) * 0.8))),
			maxi(1, int(floor(float(image.get_height()) * 0.8))),
			Image.INTERPOLATE_LANCZOS
		)
		encoded = image.save_png_to_buffer()
	if encoded.is_empty() or encoded.size() > MAX_VISUAL_BYTES:
		_send_visual_error(capture_id, "The running game screenshot exceeds the 8 MiB limit")
		return
	var current_scene_path := ""
	if tree.current_scene != null:
		current_scene_path = str(tree.current_scene.scene_file_path)
	EngineDebugger.send_message(
		&"godetx_visual:screenshot",
		[{
			"v": VISUAL_PROTOCOL_VERSION,
			"ok": true,
			"run_id": _run_id,
			"capture_id": capture_id,
			"scene_path": current_scene_path,
			"frame": Engine.get_process_frames(),
			"viewport_width": int(viewport_size.x),
			"viewport_height": int(viewport_size.y),
			"width": image.get_width(),
			"height": image.get_height(),
			"mime_type": "image/png",
			"size_bytes": encoded.size(),
			"captured_at_ms": Time.get_ticks_msec(),
		}, encoded]
	)


func _send_visual_error(capture_id: String, error: String) -> void:
	if not EngineDebugger.is_active() or capture_id.is_empty():
		return
	EngineDebugger.send_message(
		&"godetx_visual:screenshot",
		[{
			"v": VISUAL_PROTOCOL_VERSION,
			"ok": false,
			"run_id": _run_id,
			"capture_id": capture_id,
			"error": error.left(512),
			"captured_at_ms": Time.get_ticks_msec(),
		}, PackedByteArray()]
	)


func _send_automation_event(status: Dictionary) -> void:
	if not EngineDebugger.is_active():
		return
	EngineDebugger.send_message(
		&"godetx_automation:event",
		[status.duplicate(true)]
	)


static func _validate_automation_envelope(data: Array, expected_run_id: String) -> Dictionary:
	if data.size() != 1 or not data[0] is Dictionary:
		return {"ok": false, "error": "Automation data must contain one request object"}
	var raw: Dictionary = data[0] as Dictionary
	if JSON.stringify(raw).to_utf8_buffer().size() > RuntimeAutomationDriver.MAX_PLAN_BYTES:
		return {"ok": false, "error": "Automation request exceeds the 64 KiB limit"}
	var run_id_value: Variant = raw.get("run_id")
	var automation_id_value: Variant = raw.get("automation_id")
	if not run_id_value is String or not RuntimeAutomationDriver.is_safe_identifier(run_id_value as String):
		return {"ok": false, "error": "Invalid automation run_id"}
	if not automation_id_value is String or not RuntimeAutomationDriver.is_safe_identifier(automation_id_value as String):
		return {"ok": false, "error": "Invalid automation automation_id"}
	var automation_id: String = automation_id_value
	if run_id_value != expected_run_id:
		return {"ok": false, "error": "Automation run_id does not match the running game"}
	var reject_base: Dictionary = {
		"ok": false,
		"rejectable": true,
		"automation_id": automation_id,
		"step_count": 0,
	}
	var version_value: Variant = raw.get("v")
	if not version_value is int or int(version_value) != PROTOCOL_VERSION:
		reject_base["error"] = "Unsupported automation protocol version"
		return reject_base
	var kind_value: Variant = raw.get("kind")
	if not kind_value is String or (kind_value as String) != "execute" and (kind_value as String) != "cancel":
		reject_base["error"] = "Automation kind must be execute or cancel"
		return reject_base
	var kind: String = kind_value
	var clean: Dictionary = {
		"v": PROTOCOL_VERSION,
		"run_id": expected_run_id,
		"automation_id": automation_id,
		"kind": kind,
	}
	if kind == "cancel":
		return {"ok": true, "envelope": clean}
	var stop_value: Variant = raw.get("stop_on_failure", true)
	if not stop_value is bool:
		reject_base["error"] = "stop_on_failure must be boolean"
		return reject_base
	var validation: Dictionary = RuntimeAutomationDriver.validate_steps(raw.get("steps"))
	if not bool(validation.get("ok", false)):
		reject_base["error"] = str(validation.get("error", "Invalid automation plan"))
		var raw_steps: Variant = raw.get("steps")
		if raw_steps is Array:
			reject_base["step_count"] = mini((raw_steps as Array).size(), RuntimeAutomationDriver.MAX_STEPS)
		return reject_base
	clean["steps"] = (validation.get("steps", []) as Array).duplicate(true)
	clean["stop_on_failure"] = bool(stop_value)
	return {"ok": true, "envelope": clean}


static func _validate_visual_envelope(data: Array, expected_run_id: String) -> Dictionary:
	if data.size() != 1 or not data[0] is Dictionary:
		return {"ok": false, "error": "Screenshot data must contain one request object"}
	var raw: Dictionary = data[0] as Dictionary
	var capture_id := str(raw.get("capture_id", ""))
	var base := {"ok": false, "capture_id": capture_id}
	if not raw.get("v") is int or int(raw.get("v")) != VISUAL_PROTOCOL_VERSION:
		base["error"] = "Unsupported screenshot protocol version"
		return base
	if not raw.get("run_id") is String or str(raw.get("run_id")) != expected_run_id:
		base["error"] = "Screenshot run_id does not match the running game"
		return base
	if not RuntimeAutomationDriver.is_safe_identifier(capture_id):
		base["error"] = "Invalid screenshot capture_id"
		return base
	var max_dimension_value: Variant = raw.get("max_dimension", MAX_VISUAL_DIMENSION)
	var max_dimension_result := RuntimeAutomationDriver._bounded_integer(
		max_dimension_value,
		MIN_VISUAL_DIMENSION,
		MAX_VISUAL_DIMENSION
	)
	if not bool(max_dimension_result.get("ok", false)):
		base["error"] = "max_dimension must be an integer from %d to %d" % [
			MIN_VISUAL_DIMENSION,
			MAX_VISUAL_DIMENSION,
		]
		return base
	var max_dimension := int(max_dimension_result.get("value", 0))
	return {
		"ok": true,
		"request": {
			"v": VISUAL_PROTOCOL_VERSION,
			"run_id": expected_run_id,
			"capture_id": capture_id,
			"max_dimension": max_dimension,
		},
	}


static func _read_run_id(arguments: PackedStringArray) -> String:
	for argument in arguments:
		if argument.begins_with(RUN_ARGUMENT_PREFIX):
			var candidate: String = argument.substr(RUN_ARGUMENT_PREFIX.length())
			return candidate if _is_safe_run_id(candidate) else ""
	return ""


static func _is_safe_run_id(value: String) -> bool:
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
