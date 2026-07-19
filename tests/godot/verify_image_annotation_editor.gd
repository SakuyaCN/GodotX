extends SceneTree

const ImageAnnotationEditor := preload("res://addons/godetx/image_annotation_editor.gd")

var _failures := PackedStringArray()


func _init() -> void:
	var editor := ImageAnnotationEditor.new()
	editor.size = Vector2(400.0, 400.0)
	var source := Image.create(400, 200, false, Image.FORMAT_RGBA8)
	var source_color := Color(0.08, 0.12, 0.18, 1.0)
	source.fill(source_color)
	_assert(editor.set_image(source), "A valid image should be accepted")
	_assert(
		editor.get_image_display_rect().is_equal_approx(
			Rect2(Vector2(0.0, 100.0), Vector2(400.0, 200.0))
		),
		"Keep-aspect display should letterbox the source image"
	)
	_assert(
		editor.display_position_to_normalized(Vector2(200.0, 200.0)).is_equal_approx(
			Vector2(0.5, 0.5)
		),
		"Display coordinates should map to original-image normalized coordinates"
	)
	_assert(
		editor.display_position_to_normalized(Vector2(200.0, 50.0))
		== ImageAnnotationEditor.INVALID_NORMALIZED_POINT,
		"Letterbox padding should not start an annotation"
	)
	_assert(
		editor.display_position_to_normalized(Vector2(200.0, 50.0), true).is_equal_approx(
			Vector2(0.5, 0.0)
		),
		"An active drag should clamp to the image edge"
	)

	_assert(editor.set_tool_mode_name("circle"), "Tool modes should be selectable by name")
	var square_end: Vector2 = editor._square_circle_corner(Vector2(0.25, 0.25), Vector2(0.5, 0.5))
	var square_delta := (square_end - Vector2(0.25, 0.25)) * Vector2(editor.get_image_size())
	_assert(
		is_equal_approx(absf(square_delta.x), absf(square_delta.y)),
		"Circle drag bounds should be square in original pixel space"
	)

	var arrow := editor.add_annotation("arrow", Vector2(0.1, 0.2), Vector2(0.8, 0.7))
	var rectangle := editor.add_annotation("rectangle", Vector2(0.2, 0.25), Vector2(0.6, 0.65))
	var circle := editor.add_annotation("circle", Vector2(0.55, 0.1), Vector2(0.75, 0.5))
	_assert(
		editor.add_annotation("arrow", Vector2(0.5, 0.5), Vector2(0.5, 0.5)).is_empty(),
		"Programmatic zero-length annotations should be rejected"
	)
	_assert(
		int(arrow.get("id", 0)) == 1
		and int(rectangle.get("id", 0)) == 2
		and int(circle.get("id", 0)) == 3,
		"Committed annotations should receive stable sequential IDs"
	)
	var annotations := editor.get_annotations()
	_assert(annotations.size() == 3, "All annotation types should be retained")
	if annotations.size() == 3:
		var first: Dictionary = annotations[0]
		_assert(
			first.size() == 4
			and first.has("id")
			and first.has("type")
			and first.has("start")
			and first.has("end")
			and first.get("type") == "arrow"
			and first.get("start") is Array
			and first.get("end") is Array,
			"Annotations should use the provider-independent primitive schema"
		)
	var payload := editor.get_annotation_payload()
	_assert(
		payload.get("coordinate_space") == "image_normalized"
		and payload.get("image_width") == 400
		and payload.get("image_height") == 200,
		"The annotation payload should describe its normalized image coordinate space"
	)

	var annotated: Image = editor.get_annotated_image()
	_assert(
		annotated != null and annotated.get_size() == source.get_size(),
		"Raster export should preserve the original image dimensions"
	)
	if annotated != null:
		var target := Vector2i(roundi(399.0 * 0.8), roundi(199.0 * 0.7))
		_assert(
			not annotated.get_pixelv(target).is_equal_approx(source_color),
			"Raster export should draw the arrow target into the copied image"
		)
		_assert(
			source.get_pixelv(target).is_equal_approx(source_color),
			"Raster export must not mutate the caller's source image"
		)

	_assert(editor.clear_annotations(), "Clear should remove existing annotations")
	_assert(editor.get_annotations().is_empty(), "Clear should empty the annotation list")
	_assert(editor.undo(), "Clear should be undoable")
	_assert(editor.get_annotations().size() == 3, "Undo should restore annotations cleared together")
	_assert(editor.undo(), "Individual annotation additions should remain undoable")
	_assert(editor.get_annotations().size() == 2, "Undo should restore the previous annotation snapshot")

	editor.set_annotations([
		{
			"id": 7,
			"type": "circle",
			"start": [1.5, 0.75],
			"end": [-0.5, 0.25],
		},
		{
			"id": 7,
			"type": "arrow",
			"start": [0.0, 0.0],
			"end": [1.0, 1.0],
		},
		{
			"id": 8,
			"type": "unsupported",
			"start": [0.0, 0.0],
			"end": [1.0, 1.0],
		},
		{
			"id": 33,
			"type": "arrow",
			"start": [0.0, 0.0],
			"end": [1.0, 1.0],
		},
	])
	var sanitized := editor.get_annotations()
	_assert(
		sanitized.size() == 1
		and sanitized[0].get("start") == [0.0, 0.25]
		and sanitized[0].get("end") == [1.0, 0.75],
		"Imported annotations should reject duplicate IDs and clamp normalized points"
	)

	editor.set_annotations([])
	for index in range(ImageAnnotationEditor.MAX_ANNOTATIONS):
		var y := 0.02 + float(index) * 0.02
		_assert(
			not editor.add_annotation("arrow", Vector2(0.1, y), Vector2(0.2, y)).is_empty(),
			"Annotations within the safety limit should be accepted"
		)
	_assert(
		editor.get_annotations().size() == ImageAnnotationEditor.MAX_ANNOTATIONS
		and editor.add_annotation("arrow", Vector2(0.2, 0.2), Vector2(0.3, 0.3)).is_empty(),
		"The editor should enforce the 32-annotation safety limit"
	)

	editor.free()
	if not _failures.is_empty():
		for failure in _failures:
			printerr(failure)
		quit(1)
		return
	print("GODETX_IMAGE_ANNOTATION_EDITOR_OK")
	quit(0)


func _assert(condition: bool, message: String) -> void:
	if not condition:
		_failures.append(message)
