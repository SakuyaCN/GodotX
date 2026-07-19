@tool
class_name GodetXAttachmentStore
extends RefCounted

const STORAGE_DIRECTORY := "user://godetx/attachments"
const MAX_ATTACHMENTS_PER_TURN := 4
const MAX_SOURCE_BYTES := 20 * 1024 * 1024
const MAX_ENCODED_BYTES := 8 * 1024 * 1024
const MAX_SOURCE_PIXELS := 16_777_216
const MAX_IMAGE_DIMENSION := 2048
const MIN_IMAGE_DIMENSION := 64
const MAX_DISPLAY_NAME_LENGTH := 160
const MAX_ANNOTATIONS_PER_IMAGE := 32
const PNG_MIME_TYPE := "image/png"
const DEFAULT_DETAIL := "high"
const ALLOWED_DETAILS := ["low", "high"]
const ALLOWED_SOURCES := [
	"file",
	"clipboard",
	"project_resource",
	"editor_viewport",
	"game_frame",
]
const TURN_REFERENCE_KEYS := [
	"attachment_id",
	"detail",
	"source",
	"name",
	"run_id",
	"scene_id",
	"scene_path",
	"captured_at_ms",
	"viewport_width",
	"viewport_height",
	"frame",
	"annotated_from",
	"annotations",
]
const METADATA_KEYS := [
	"attachment_id",
	"mime_type",
	"width",
	"height",
	"size_bytes",
	"byte_size",
	"detail",
	"source",
	"name",
	"run_id",
	"scene_id",
	"scene_path",
	"captured_at_ms",
	"viewport_width",
	"viewport_height",
	"frame",
	"annotated_from",
	"annotations",
]


func import_file(
	path: String,
	source: String = "file",
	detail: String = DEFAULT_DETAIL,
	extra: Dictionary = {}
) -> Dictionary:
	var clean_path := path.strip_edges()
	if clean_path.is_empty():
		return _error("Image path is required")
	var file := FileAccess.open(clean_path, FileAccess.READ)
	if file == null:
		return _error("Image file could not be opened")
	var source_bytes: int = file.get_length()
	file.close()
	if source_bytes <= 0:
		return _error("Image file is empty")
	if source_bytes > MAX_SOURCE_BYTES:
		return _error("Image file exceeds the 20 MiB limit")
	var image: Image = Image.load_from_file(clean_path)
	if image == null or image.is_empty():
		return _error("Image file could not be decoded")
	return import_image(image, source, clean_path.get_file(), detail, extra)


func import_texture(
	texture: Texture2D,
	source: String,
	display_name: String,
	detail: String = DEFAULT_DETAIL,
	extra: Dictionary = {}
) -> Dictionary:
	if texture == null:
		return _error("Texture is unavailable")
	var image: Image = texture.get_image()
	if image == null or image.is_empty():
		return _error("Texture pixels are unavailable")
	return import_image(image, source, display_name, detail, extra)


func import_image(
	image: Image,
	source: String,
	display_name: String = "",
	detail: String = DEFAULT_DETAIL,
	extra: Dictionary = {}
) -> Dictionary:
	if image == null or image.is_empty():
		return _error("Image is empty")
	var source_size: Vector2i = image.get_size()
	if not _is_safe_source_size(source_size):
		return _error("Image dimensions exceed the 16 megapixel safety limit")
	var annotated_from := str(extra.get("annotated_from", ""))
	if not annotated_from.is_empty() and not is_safe_attachment_id(annotated_from):
		return _error("Image annotation source is invalid")
	var annotations: Array = []
	if extra.has("annotations"):
		var annotation_result := _validate_annotations(extra.get("annotations"))
		if not bool(annotation_result.get("ok", false)):
			return _error(str(annotation_result.get("error", "Image annotations are invalid")))
		annotations = annotation_result.get("annotations", [])
	var normalized: Image = image.duplicate() as Image
	if normalized == null:
		return _error("Image could not be copied")
	if normalized.is_compressed():
		var decompress_error: Error = normalized.decompress()
		if decompress_error != OK:
			return _error("Image compression format could not be decoded")
	var target_size := scaled_size(normalized.get_size(), MAX_IMAGE_DIMENSION)
	if target_size != normalized.get_size():
		normalized.resize(target_size.x, target_size.y, Image.INTERPOLATE_LANCZOS)
	if normalized.get_format() != Image.FORMAT_RGBA8:
		normalized.convert(Image.FORMAT_RGBA8)

	var encoded: PackedByteArray = normalized.save_png_to_buffer()
	while (
		encoded.size() > MAX_ENCODED_BYTES
		and mini(normalized.get_width(), normalized.get_height()) > MIN_IMAGE_DIMENSION
	):
		var reduced_size := scaled_size(normalized.get_size(), maxi(
			MIN_IMAGE_DIMENSION,
			int(floor(float(maxi(normalized.get_width(), normalized.get_height())) * 0.8))
		))
		if reduced_size == normalized.get_size():
			break
		normalized.resize(reduced_size.x, reduced_size.y, Image.INTERPOLATE_LANCZOS)
		encoded = normalized.save_png_to_buffer()
	if encoded.is_empty():
		return _error("Image could not be encoded as PNG")
	if encoded.size() > MAX_ENCODED_BYTES:
		return _error("Encoded image exceeds the 8 MiB limit")

	var attachment_id := _sha256_bytes(encoded)
	if attachment_id.is_empty():
		return _error("Image hash could not be calculated")
	var storage_result := _store_encoded_image(attachment_id, encoded)
	if not bool(storage_result.get("ok", false)):
		return storage_result
	var attachment := {
		"attachment_id": attachment_id,
		"mime_type": PNG_MIME_TYPE,
		"width": normalized.get_width(),
		"height": normalized.get_height(),
		"size_bytes": encoded.size(),
		"detail": detail if ALLOWED_DETAILS.has(detail) else DEFAULT_DETAIL,
		"source": _safe_source(source),
	}
	var safe_name := safe_display_name(display_name)
	if not safe_name.is_empty():
		attachment["name"] = safe_name
	for key in ["run_id", "scene_id", "scene_path"]:
		var value := str(extra.get(key, "")).strip_edges()
		if not value.is_empty():
			attachment[key] = value.left(1024 if key == "scene_path" else 128)
	for key in ["captured_at_ms", "viewport_width", "viewport_height", "frame"]:
		var number_value: Variant = extra.get(key)
		if number_value is int or number_value is float:
			var integer_value := int(number_value)
			var minimum_value := 1 if key.begins_with("viewport_") else 0
			if integer_value >= minimum_value:
				attachment[key] = integer_value
	if not annotated_from.is_empty():
		attachment["annotated_from"] = annotated_from
	if not annotations.is_empty():
		attachment["annotations"] = annotations
	return {
		"ok": true,
		"attachment": attachment,
		"deduplicated": bool(storage_result.get("deduplicated", false)),
	}


func load_preview(attachment: Dictionary) -> Texture2D:
	var image := load_image(attachment)
	if image == null:
		return null
	return ImageTexture.create_from_image(image)


func load_image(attachment: Dictionary) -> Image:
	var attachment_id := str(attachment.get("attachment_id", ""))
	if not is_safe_attachment_id(attachment_id):
		return null
	if not FileAccess.file_exists(attachment_path(attachment_id)):
		return null
	var image := Image.new()
	var load_error: Error = image.load(attachment_path(attachment_id))
	if load_error != OK or image.is_empty():
		return null
	return image


func attachment_path(attachment_id: String) -> String:
	return "%s/%s.png" % [STORAGE_DIRECTORY, attachment_id]


static func protocol_reference(value: Dictionary) -> Dictionary:
	var reference := {}
	for key in TURN_REFERENCE_KEYS:
		if value.has(key):
			var field_value: Variant = value[key]
			reference[key] = (
				field_value.duplicate(true)
				if field_value is Array or field_value is Dictionary
				else field_value
			)
	return reference


static func metadata_reference(value: Dictionary) -> Dictionary:
	var reference := {}
	for key in METADATA_KEYS:
		if value.has(key):
			var field_value: Variant = value[key]
			reference[key] = (
				field_value.duplicate(true)
				if field_value is Array or field_value is Dictionary
				else field_value
			)
	return reference


static func is_safe_attachment_id(value: String) -> bool:
	if value.length() != 64:
		return false
	for index in range(value.length()):
		var character := value.unicode_at(index)
		var is_digit := character >= 48 and character <= 57
		var is_hex_letter := character >= 97 and character <= 102
		if not is_digit and not is_hex_letter:
			return false
	return true


static func scaled_size(source: Vector2i, maximum_dimension: int) -> Vector2i:
	if source.x <= 0 or source.y <= 0 or maximum_dimension <= 0:
		return Vector2i.ZERO
	var longest := maxi(source.x, source.y)
	if longest <= maximum_dimension:
		return source
	var scale := float(maximum_dimension) / float(longest)
	return Vector2i(
		maxi(1, int(round(float(source.x) * scale))),
		maxi(1, int(round(float(source.y) * scale)))
	)


static func safe_display_name(value: String) -> String:
	var clean := value.strip_edges().replace("\n", " ").replace("\r", " ").replace("\t", " ")
	while clean.contains("  "):
		clean = clean.replace("  ", " ")
	return clean.left(MAX_DISPLAY_NAME_LENGTH)


static func normalize_annotations(value: Variant) -> Array:
	var result := _validate_annotations(value)
	return result.get("annotations", []) if bool(result.get("ok", false)) else []


static func _validate_annotations(value: Variant) -> Dictionary:
	if not value is Array:
		return _error("Image annotations must be an array")
	var values: Array = value
	if values.size() > MAX_ANNOTATIONS_PER_IMAGE:
		return _error("Image annotations exceed the limit")
	var result: Array = []
	var seen_ids := {}
	for index in range(values.size()):
		var raw_value: Variant = values[index]
		if not raw_value is Dictionary:
			return _error("Image annotation %d must be an object" % (index + 1))
		var raw: Dictionary = raw_value
		if raw.size() != 4 or not (
			raw.has("id") and raw.has("type") and raw.has("start") and raw.has("end")
		):
			return _error("Image annotation %d has unsupported fields" % (index + 1))
		var annotation_id_value: Variant = raw.get("id")
		if not annotation_id_value is int:
			return _error("Image annotation %d has an invalid id" % (index + 1))
		var annotation_id := int(annotation_id_value)
		if annotation_id < 1 or annotation_id > MAX_ANNOTATIONS_PER_IMAGE or seen_ids.has(annotation_id):
			return _error("Image annotation %d has an invalid id" % (index + 1))
		var shape_type := str(raw.get("type", "")).strip_edges().to_lower()
		if not ["arrow", "rectangle", "circle"].has(shape_type):
			return _error("Image annotation %d has an invalid type" % (index + 1))
		var start_result := _normalized_point(raw.get("start"))
		var end_result := _normalized_point(raw.get("end"))
		if not bool(start_result.get("ok", false)) or not bool(end_result.get("ok", false)):
			return _error("Image annotation %d has invalid coordinates" % (index + 1))
		var start: Array = start_result.get("point", [])
		var end: Array = end_result.get("point", [])
		var delta := Vector2(float(end[0]) - float(start[0]), float(end[1]) - float(start[1]))
		if delta.length_squared() < 0.000001:
			return _error("Image annotation %d is too small" % (index + 1))
		if shape_type != "arrow":
			var minimum := Vector2(minf(float(start[0]), float(end[0])), minf(float(start[1]), float(end[1])))
			var maximum := Vector2(maxf(float(start[0]), float(end[0])), maxf(float(start[1]), float(end[1])))
			start = [minimum.x, minimum.y]
			end = [maximum.x, maximum.y]
		seen_ids[annotation_id] = true
		result.append({
			"id": annotation_id,
			"type": shape_type,
			"start": start,
			"end": end,
		})
	return {"ok": true, "annotations": result}


static func _normalized_point(value: Variant) -> Dictionary:
	if not value is Array or (value as Array).size() != 2:
		return {"ok": false}
	var values: Array = value
	var point: Array = []
	for coordinate in values:
		if not coordinate is int and not coordinate is float:
			return {"ok": false}
		var number := float(coordinate)
		if not is_finite(number) or number < 0.0 or number > 1.0:
			return {"ok": false}
		point.append(number)
	return {"ok": true, "point": point}


static func _is_safe_source_size(size: Vector2i) -> bool:
	if size.x <= 0 or size.y <= 0:
		return false
	return int(size.x) * int(size.y) <= MAX_SOURCE_PIXELS


static func _safe_source(value: String) -> String:
	var clean := value.strip_edges().to_lower().replace("-", "_")
	return clean if ALLOWED_SOURCES.has(clean) else "file"


static func _sha256_bytes(bytes: PackedByteArray) -> String:
	var hashing := HashingContext.new()
	if hashing.start(HashingContext.HASH_SHA256) != OK:
		return ""
	if hashing.update(bytes) != OK:
		return ""
	return hashing.finish().hex_encode()


func _store_encoded_image(attachment_id: String, bytes: PackedByteArray) -> Dictionary:
	var absolute_directory := ProjectSettings.globalize_path(STORAGE_DIRECTORY)
	var directory_error: Error = DirAccess.make_dir_recursive_absolute(absolute_directory)
	if directory_error != OK and directory_error != ERR_ALREADY_EXISTS:
		return _error("Attachment storage directory could not be created")
	var final_path := ProjectSettings.globalize_path(attachment_path(attachment_id))
	if FileAccess.file_exists(final_path):
		return {"ok": true, "deduplicated": true}
	var temporary_path := "%s.tmp-%s" % [final_path, str(Time.get_ticks_usec())]
	var file := FileAccess.open(temporary_path, FileAccess.WRITE)
	if file == null:
		return _error("Attachment file could not be created")
	file.store_buffer(bytes)
	file.flush()
	file.close()
	var rename_error: Error = DirAccess.rename_absolute(temporary_path, final_path)
	if rename_error != OK:
		if FileAccess.file_exists(final_path):
			DirAccess.remove_absolute(temporary_path)
			return {"ok": true, "deduplicated": true}
		DirAccess.remove_absolute(temporary_path)
		return _error("Attachment file could not be finalized")
	return {"ok": true, "deduplicated": false}


static func _error(message: String) -> Dictionary:
	return {"ok": false, "error": message}
