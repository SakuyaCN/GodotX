extends SceneTree

const AttachmentStore := preload("res://addons/godetx/attachment_store.gd")
const VisualCapture := preload("res://addons/godetx/visual_capture.gd")

var _failures := PackedStringArray()


func _init() -> void:
	_assert(
		AttachmentStore.scaled_size(Vector2i(4096, 2048), 2048) == Vector2i(2048, 1024),
		"Attachment scaling should preserve aspect ratio"
	)
	_assert(
		AttachmentStore.scaled_size(Vector2i(320, 180), 2048) == Vector2i(320, 180),
		"Small images should not be enlarged"
	)
	var safe_id := "a".repeat(64)
	_assert(AttachmentStore.is_safe_attachment_id(safe_id), "SHA-256 attachment IDs should be accepted")
	_assert(
		not AttachmentStore.is_safe_attachment_id("A".repeat(64))
		and not AttachmentStore.is_safe_attachment_id("../unsafe"),
		"Attachment IDs must be lowercase SHA-256 hex"
	)
	var reference := AttachmentStore.protocol_reference({
		"attachment_id": safe_id,
		"mime_type": "image/png",
		"width": 32,
		"height": 16,
		"size_bytes": 128,
		"detail": "high",
		"source": "clipboard",
		"name": "sample.png",
		"captured_at_ms": 1234,
		"local_path": "C:/must/not/leak.png",
		"preview": "not protocol data",
	})
	_assert(
		reference.has("attachment_id")
		and reference.get("captured_at_ms") == 1234
		and not reference.has("mime_type")
		and not reference.has("width")
		and not reference.has("local_path")
		and not reference.has("preview"),
		"Attachment protocol references should expose only the allowlisted metadata"
	)
	_assert(
		VisualCapture.normalize_project_resource_path("textures/icon.png").get("path")
		== "res://textures/icon.png",
		"Project resources should normalize to res:// paths"
	)
	_assert(
		not bool(VisualCapture.normalize_project_resource_path("../outside.png").get("ok", true)),
		"Project resource previews must reject traversal"
	)
	var annotations := AttachmentStore.normalize_annotations([
		{"id": 1, "type": "arrow", "start": [0.1, 0.2], "end": [0.8, 0.7]},
		{"id": 2, "type": "rectangle", "start": [0.9, 0.8], "end": [0.4, 0.3]},
		{"id": 3, "type": "circle", "start": [0.2, 0.1], "end": [0.6, 0.5]},
	])
	_assert(
		annotations.size() == 3
		and (annotations[0] as Dictionary).get("type") == "arrow"
		and (annotations[1] as Dictionary).get("start") == [0.4, 0.3],
		"Image annotations should preserve arrow direction and normalize bounded shapes"
	)
	_assert(
		AttachmentStore.normalize_annotations([
			{"id": 1, "type": "triangle", "start": [0.0, 0.0], "end": [1.0, 1.0]},
		]).is_empty(),
		"Image annotations should reject unsupported shapes"
	)
	var store := AttachmentStore.new()
	var image := Image.create(32, 16, false, Image.FORMAT_RGBA8)
	image.fill(Color(0.2, 0.4, 0.7, 1.0))
	var first: Dictionary = store.import_image(image, "clipboard", "sample.png")
	var second: Dictionary = store.import_image(image, "clipboard", "sample.png")
	var annotated: Dictionary = store.import_image(image, "clipboard", "annotated.png", "high", {
		"annotated_from": safe_id,
		"annotations": annotations,
	})
	_assert(bool(first.get("ok", false)), "An in-memory image should be stored")
	_assert(bool(second.get("ok", false)), "A duplicate image should remain usable")
	_assert(
		bool(annotated.get("ok", false))
		and ((annotated.get("attachment", {}) as Dictionary).get("annotations", []) as Array).size() == 3,
		"Stored attachments should retain validated annotation metadata"
	)
	if bool(first.get("ok", false)) and bool(second.get("ok", false)):
		var first_attachment: Dictionary = first.get("attachment", {})
		var second_attachment: Dictionary = second.get("attachment", {})
		_assert(
			first_attachment.get("attachment_id") == second_attachment.get("attachment_id")
			and bool(second.get("deduplicated", false)),
			"Identical normalized images should share one content-addressed file"
		)
		_assert(
			FileAccess.file_exists(store.attachment_path(str(first_attachment.get("attachment_id", "")))),
			"Stored attachments should be available in the shared user data directory"
		)
		_assert(store.load_preview(first_attachment) != null, "Stored images should load as UI previews")

	if not _failures.is_empty():
		for failure in _failures:
			printerr(failure)
		quit(1)
		return
	print("GODETX_ATTACHMENT_STORE_OK")
	quit(0)


func _assert(condition: bool, message: String) -> void:
	if not condition:
		_failures.append(message)
