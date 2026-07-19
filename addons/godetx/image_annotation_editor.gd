@tool
class_name GodetXImageAnnotationEditor
extends Control

signal annotations_changed(annotations: Array)
signal annotation_committed(annotation: Dictionary)
signal drawing_state_changed(is_drawing: bool)

enum ToolMode {
	ARROW,
	RECTANGLE,
	CIRCLE,
}

const ANNOTATION_VERSION := 1
const COORDINATE_SPACE := "image_normalized"
const MAX_ANNOTATIONS := 32
const MAX_HISTORY_ENTRIES := 64
const MIN_DRAG_DISTANCE := 4.0
const DEFAULT_ARROW_OFFSET := Vector2(48.0, 36.0)
const DEFAULT_SHAPE_SIZE := Vector2(48.0, 48.0)
const INVALID_NORMALIZED_POINT := Vector2(-1.0, -1.0)
const ANNOTATION_TYPES := ["arrow", "rectangle", "circle"]
const DIGIT_PATTERNS := {
	"0": ["111", "101", "101", "101", "111"],
	"1": ["010", "110", "010", "010", "111"],
	"2": ["111", "001", "111", "100", "111"],
	"3": ["111", "001", "111", "001", "111"],
	"4": ["101", "101", "111", "001", "001"],
	"5": ["111", "100", "111", "001", "111"],
	"6": ["111", "100", "111", "101", "111"],
	"7": ["111", "001", "010", "010", "010"],
	"8": ["111", "101", "111", "101", "111"],
	"9": ["111", "101", "111", "001", "111"],
}

var annotation_color := Color(0.96, 0.22, 0.20, 1.0)
var preview_color := Color(1.0, 0.55, 0.18, 0.78)
var canvas_background_color := Color(0.08, 0.09, 0.11, 1.0)

var _source_image: Image
var _image_texture: ImageTexture
var _annotations: Array[Dictionary] = []
var _history: Array = []
var _tool_mode := ToolMode.ARROW
var _next_id := 1
var _dragging := false
var _drag_start := Vector2.ZERO
var _drag_current := Vector2.ZERO


func _init() -> void:
	mouse_filter = Control.MOUSE_FILTER_STOP
	focus_mode = Control.FOCUS_ALL
	mouse_default_cursor_shape = Control.CURSOR_CROSS
	clip_contents = true
	custom_minimum_size = Vector2(220.0, 140.0)


func set_image(image: Image, reset_annotations: bool = true) -> bool:
	if image == null or image.is_empty():
		return false
	var normalized: Image = image.duplicate() as Image
	if normalized == null:
		return false
	if normalized.is_compressed() and normalized.decompress() != OK:
		return false
	if normalized.get_format() != Image.FORMAT_RGBA8:
		normalized.convert(Image.FORMAT_RGBA8)
	_source_image = normalized
	_image_texture = ImageTexture.create_from_image(_source_image)
	_cancel_drawing_internal()
	if reset_annotations:
		_annotations.clear()
		_history.clear()
		_next_id = 1
		annotations_changed.emit(get_annotations())
	queue_redraw()
	return true


func set_texture(texture: Texture2D, reset_annotations: bool = true) -> bool:
	if texture == null:
		return false
	var image: Image = texture.get_image()
	return set_image(image, reset_annotations)


func clear_image() -> void:
	_cancel_drawing_internal()
	_source_image = null
	_image_texture = null
	_annotations.clear()
	_history.clear()
	_next_id = 1
	annotations_changed.emit(get_annotations())
	queue_redraw()


func has_image() -> bool:
	return _source_image != null and not _source_image.is_empty()


func get_image_size() -> Vector2i:
	return _source_image.get_size() if has_image() else Vector2i.ZERO


func set_tool_mode(mode: int) -> bool:
	if mode < ToolMode.ARROW or mode > ToolMode.CIRCLE:
		return false
	if _tool_mode == mode:
		return true
	_cancel_drawing_internal()
	_tool_mode = mode
	queue_redraw()
	return true


func set_tool_mode_name(mode_name: String) -> bool:
	match mode_name.strip_edges().to_lower():
		"arrow":
			return set_tool_mode(ToolMode.ARROW)
		"rectangle":
			return set_tool_mode(ToolMode.RECTANGLE)
		"circle":
			return set_tool_mode(ToolMode.CIRCLE)
	return false


func get_tool_mode() -> int:
	return _tool_mode


func get_tool_mode_name() -> String:
	return _tool_name(_tool_mode)


func is_drawing() -> bool:
	return _dragging


func cancel_drawing() -> void:
	_cancel_drawing_internal()


func get_image_display_rect() -> Rect2:
	if not has_image() or size.x <= 0.0 or size.y <= 0.0:
		return Rect2()
	var image_size := Vector2(_source_image.get_size())
	var scale := minf(size.x / image_size.x, size.y / image_size.y)
	if scale <= 0.0:
		return Rect2()
	var display_size := image_size * scale
	return Rect2((size - display_size) * 0.5, display_size)


func is_position_over_image(local_position: Vector2) -> bool:
	var image_rect := get_image_display_rect()
	return image_rect.size.x > 0.0 and image_rect.size.y > 0.0 and image_rect.has_point(local_position)


func display_position_to_normalized(
	local_position: Vector2,
	clamp_to_image: bool = false
) -> Vector2:
	var image_rect := get_image_display_rect()
	if image_rect.size.x <= 0.0 or image_rect.size.y <= 0.0:
		return INVALID_NORMALIZED_POINT
	if not clamp_to_image and not image_rect.has_point(local_position):
		return INVALID_NORMALIZED_POINT
	var relative := (local_position - image_rect.position) / image_rect.size
	return Vector2(clampf(relative.x, 0.0, 1.0), clampf(relative.y, 0.0, 1.0))


func normalized_position_to_display(normalized_position: Vector2) -> Vector2:
	var image_rect := get_image_display_rect()
	if image_rect.size.x <= 0.0 or image_rect.size.y <= 0.0:
		return Vector2.ZERO
	var safe := Vector2(
		clampf(normalized_position.x, 0.0, 1.0),
		clampf(normalized_position.y, 0.0, 1.0)
	)
	return image_rect.position + safe * image_rect.size


func add_annotation(type_name: String, start: Vector2, end: Vector2) -> Dictionary:
	if not has_image() or _annotations.size() >= MAX_ANNOTATIONS:
		return {}
	var safe_type := type_name.strip_edges().to_lower()
	if not ANNOTATION_TYPES.has(safe_type):
		return {}
	if not _is_finite_point(start) or not _is_finite_point(end):
		return {}
	var safe_start := _clamp_normalized(start)
	var safe_end := _clamp_normalized(end)
	if safe_type != "arrow":
		var bounds := _rect_from_points(safe_start, safe_end)
		safe_start = bounds.position
		safe_end = bounds.end
	if not _has_valid_geometry(safe_type, safe_start, safe_end):
		return {}
	if _next_id < 1 or _next_id > MAX_ANNOTATIONS:
		return {}
	_push_history()
	var annotation := {
		"id": _next_id,
		"type": safe_type,
		"start": _point_array(safe_start),
		"end": _point_array(safe_end),
	}
	_annotations.append(annotation)
	_recalculate_next_id()
	var emitted := annotation.duplicate(true)
	annotation_committed.emit(emitted)
	annotations_changed.emit(get_annotations())
	queue_redraw()
	return emitted


func set_annotations(values: Array) -> void:
	_cancel_drawing_internal()
	_annotations.clear()
	_history.clear()
	var used_ids := {}
	for value in values:
		if _annotations.size() >= MAX_ANNOTATIONS:
			break
		if not value is Dictionary:
			continue
		var annotation := _sanitize_annotation(value as Dictionary)
		if annotation.is_empty():
			continue
		var annotation_id := int(annotation.get("id", 0))
		if used_ids.has(annotation_id):
			continue
		used_ids[annotation_id] = true
		_annotations.append(annotation)
	_recalculate_next_id()
	annotations_changed.emit(get_annotations())
	queue_redraw()


func get_annotations() -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	for annotation in _annotations:
		result.append(annotation.duplicate(true))
	return result


func get_annotation_payload() -> Dictionary:
	var image_size := get_image_size()
	return {
		"version": ANNOTATION_VERSION,
		"coordinate_space": COORDINATE_SPACE,
		"image_width": image_size.x,
		"image_height": image_size.y,
		"annotations": get_annotations(),
	}


func can_undo() -> bool:
	return not _history.is_empty()


func undo() -> bool:
	if _history.is_empty():
		return false
	_cancel_drawing_internal()
	var restored_value: Variant = _history.pop_back()
	_annotations.clear()
	if restored_value is Array:
		for value in restored_value as Array:
			if value is Dictionary:
				_annotations.append((value as Dictionary).duplicate(true))
	_recalculate_next_id()
	annotations_changed.emit(get_annotations())
	queue_redraw()
	return true


func clear_annotations() -> bool:
	if _annotations.is_empty():
		return false
	_cancel_drawing_internal()
	_push_history()
	_annotations.clear()
	_next_id = 1
	annotations_changed.emit(get_annotations())
	queue_redraw()
	return true


func get_annotated_image() -> Image:
	if not has_image():
		return null
	var output: Image = _source_image.duplicate() as Image
	if output == null:
		return null
	if output.get_format() != Image.FORMAT_RGBA8:
		output.convert(Image.FORMAT_RGBA8)
	for annotation in _annotations:
		_raster_annotation(output, annotation)
	return output


func _notification(what: int) -> void:
	if what == NOTIFICATION_RESIZED:
		queue_redraw()


func _gui_input(event: InputEvent) -> void:
	if not has_image():
		return
	if event is InputEventMouseButton:
		var mouse_event := event as InputEventMouseButton
		if mouse_event.button_index != MOUSE_BUTTON_LEFT:
			return
		if mouse_event.pressed:
			var normalized := display_position_to_normalized(mouse_event.position, false)
			if normalized == INVALID_NORMALIZED_POINT:
				return
			grab_focus()
			_dragging = true
			_drag_start = normalized
			_drag_current = normalized
			drawing_state_changed.emit(true)
			queue_redraw()
			accept_event()
		elif _dragging:
			_update_drag(mouse_event.position)
			_commit_drag()
			accept_event()
		return
	if event is InputEventMouseMotion and _dragging:
		_update_drag((event as InputEventMouseMotion).position)
		accept_event()
		return
	if event is InputEventKey:
		var key_event := event as InputEventKey
		if not key_event.pressed or key_event.echo:
			return
		if key_event.keycode == KEY_ESCAPE and _dragging:
			cancel_drawing()
			accept_event()
		elif key_event.keycode == KEY_Z and (key_event.ctrl_pressed or key_event.meta_pressed):
			if undo():
				accept_event()


func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, size), canvas_background_color, true)
	if _image_texture == null or not has_image():
		return
	var image_rect := get_image_display_rect()
	draw_texture_rect(_image_texture, image_rect, false)
	draw_rect(image_rect, Color(1.0, 1.0, 1.0, 0.16), false, 1.0)
	for annotation in _annotations:
		_draw_annotation(annotation, annotation_color)
	if _dragging:
		_draw_annotation(_preview_annotation(), preview_color)


func _update_drag(local_position: Vector2) -> void:
	_drag_current = display_position_to_normalized(local_position, true)
	if _tool_mode == ToolMode.CIRCLE:
		_drag_current = _square_circle_corner(_drag_start, _drag_current)
	queue_redraw()


func _commit_drag() -> void:
	if not _dragging:
		return
	var start := _drag_start
	var end := _drag_current
	var start_display := normalized_position_to_display(start)
	var end_display := normalized_position_to_display(end)
	if start_display.distance_to(end_display) < MIN_DRAG_DISTANCE:
		var defaults := _default_click_geometry(start)
		start = defaults[0]
		end = defaults[1]
	var type_name := _tool_name(_tool_mode)
	_dragging = false
	drawing_state_changed.emit(false)
	add_annotation(type_name, start, end)


func _cancel_drawing_internal() -> void:
	if not _dragging:
		return
	_dragging = false
	drawing_state_changed.emit(false)
	queue_redraw()


func _preview_annotation() -> Dictionary:
	return {
		"id": _next_id,
		"type": _tool_name(_tool_mode),
		"start": _point_array(_drag_start),
		"end": _point_array(_drag_current),
	}


func _default_click_geometry(point: Vector2) -> Array[Vector2]:
	var image_rect := get_image_display_rect()
	var local_point := normalized_position_to_display(point)
	if _tool_mode == ToolMode.ARROW:
		var offset := DEFAULT_ARROW_OFFSET
		var start_local := local_point - offset
		if not image_rect.has_point(start_local):
			start_local = local_point + offset
		start_local = _clamp_to_rect(start_local, image_rect)
		return [display_position_to_normalized(start_local, true), point]
	var shape_size := Vector2(
		minf(DEFAULT_SHAPE_SIZE.x, image_rect.size.x),
		minf(DEFAULT_SHAPE_SIZE.y, image_rect.size.y)
	)
	if _tool_mode == ToolMode.CIRCLE:
		var side := minf(shape_size.x, shape_size.y)
		shape_size = Vector2(side, side)
	var top_left := local_point - shape_size * 0.5
	top_left.x = clampf(top_left.x, image_rect.position.x, image_rect.end.x - shape_size.x)
	top_left.y = clampf(top_left.y, image_rect.position.y, image_rect.end.y - shape_size.y)
	var bottom_right := top_left + shape_size
	return [
		display_position_to_normalized(top_left, true),
		display_position_to_normalized(bottom_right, true),
	]


func _square_circle_corner(start: Vector2, raw_end: Vector2) -> Vector2:
	if not has_image():
		return raw_end
	var image_size := Vector2(_source_image.get_size())
	var start_pixels := start * image_size
	var raw_pixels := raw_end * image_size
	var delta := raw_pixels - start_pixels
	var sign_x := -1.0 if delta.x < 0.0 else 1.0
	var sign_y := -1.0 if delta.y < 0.0 else 1.0
	if is_zero_approx(delta.x):
		sign_x = -1.0 if start_pixels.x > image_size.x * 0.5 else 1.0
	if is_zero_approx(delta.y):
		sign_y = -1.0 if start_pixels.y > image_size.y * 0.5 else 1.0
	var side := maxf(absf(delta.x), absf(delta.y))
	var available_x := start_pixels.x if sign_x < 0.0 else image_size.x - start_pixels.x
	var available_y := start_pixels.y if sign_y < 0.0 else image_size.y - start_pixels.y
	side = minf(side, minf(available_x, available_y))
	var end_pixels := start_pixels + Vector2(sign_x * side, sign_y * side)
	return _clamp_normalized(end_pixels / image_size)


func _draw_annotation(annotation: Dictionary, color: Color) -> void:
	var start := normalized_position_to_display(_annotation_start(annotation))
	var end := normalized_position_to_display(_annotation_end(annotation))
	var annotation_type := str(annotation.get("type", ""))
	var annotation_id := int(annotation.get("id", 0))
	var stroke_width := _display_stroke_width()
	var badge_radius := _display_badge_radius(annotation_id)
	match annotation_type:
		"arrow":
			_draw_arrow(start, end, color, stroke_width, badge_radius)
			_draw_number_badge(start, annotation_id, color, badge_radius)
		"rectangle":
			var bounds := _rect_from_points(start, end)
			draw_rect(bounds, color, false, stroke_width, true)
			_draw_number_badge(bounds.position, annotation_id, color, badge_radius)
		"circle":
			var bounds := _rect_from_points(start, end)
			_draw_ellipse(bounds, color, stroke_width)
			_draw_number_badge(bounds.position, annotation_id, color, badge_radius)


func _draw_arrow(
	start: Vector2,
	end: Vector2,
	color: Color,
	stroke_width: float,
	badge_radius: float
) -> void:
	var delta := end - start
	var distance := delta.length()
	if distance <= 0.001:
		return
	var direction := delta / distance
	var shaft_start := start + direction * minf(badge_radius + 2.0, distance * 0.35)
	draw_line(shaft_start, end, color, stroke_width, true)
	var head_size := clampf(distance * 0.24, 9.0, 18.0)
	var left := end - direction.rotated(0.58) * head_size
	var right := end - direction.rotated(-0.58) * head_size
	draw_line(end, left, color, stroke_width, true)
	draw_line(end, right, color, stroke_width, true)


func _draw_ellipse(bounds: Rect2, color: Color, stroke_width: float) -> void:
	if bounds.size.x <= 0.001 or bounds.size.y <= 0.001:
		return
	var points := PackedVector2Array()
	var center := bounds.get_center()
	var radius := bounds.size * 0.5
	for index in range(65):
		var angle := TAU * float(index) / 64.0
		points.append(center + Vector2(cos(angle) * radius.x, sin(angle) * radius.y))
	draw_polyline(points, color, stroke_width, true)


func _draw_number_badge(center: Vector2, annotation_id: int, color: Color, radius: float) -> void:
	draw_circle(center, radius, color)
	var font: Font = ThemeDB.fallback_font
	if font == null:
		return
	var text := str(annotation_id)
	var font_size := maxi(10, int(round(radius * 1.18)))
	var text_size := font.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1.0, font_size)
	var baseline := center + Vector2(
		-text_size.x * 0.5,
		(font.get_ascent(font_size) - font.get_descent(font_size)) * 0.5
	)
	draw_string(
		font,
		baseline,
		text,
		HORIZONTAL_ALIGNMENT_LEFT,
		-1.0,
		font_size,
		Color.WHITE
	)


func _display_stroke_width() -> float:
	var image_rect := get_image_display_rect()
	return clampf(minf(image_rect.size.x, image_rect.size.y) * 0.006, 2.0, 5.0)


func _display_badge_radius(annotation_id: int) -> float:
	var image_rect := get_image_display_rect()
	var base := clampf(minf(image_rect.size.x, image_rect.size.y) * 0.026, 10.0, 17.0)
	return base + float(maxi(0, str(annotation_id).length() - 2)) * 3.0


func _raster_annotation(image: Image, annotation: Dictionary) -> void:
	var image_size := Vector2(image.get_size())
	var pixel_extent := Vector2(maxf(0.0, image_size.x - 1.0), maxf(0.0, image_size.y - 1.0))
	var start := _annotation_start(annotation) * pixel_extent
	var end := _annotation_end(annotation) * pixel_extent
	var annotation_id := int(annotation.get("id", 0))
	var base_scale := maxi(1, int(round(minf(image_size.x, image_size.y) / 640.0)))
	var stroke_width := maxi(2, base_scale * 3)
	var badge_radius := maxi(10, base_scale * 11)
	badge_radius += maxi(0, str(annotation_id).length() - 2) * base_scale * 3
	match str(annotation.get("type", "")):
		"arrow":
			_raster_arrow(image, start, end, annotation_color, stroke_width, badge_radius)
			_raster_number_badge(image, start, annotation_id, annotation_color, badge_radius)
		"rectangle":
			var bounds := _rect_from_points(start, end)
			_raster_rectangle(image, bounds, annotation_color, stroke_width)
			_raster_number_badge(image, bounds.position, annotation_id, annotation_color, badge_radius)
		"circle":
			var bounds := _rect_from_points(start, end)
			_raster_ellipse(image, bounds, annotation_color, stroke_width)
			_raster_number_badge(image, bounds.position, annotation_id, annotation_color, badge_radius)


func _raster_arrow(
	image: Image,
	start: Vector2,
	end: Vector2,
	color: Color,
	stroke_width: int,
	badge_radius: int
) -> void:
	var delta := end - start
	var distance := delta.length()
	if distance <= 0.001:
		return
	var direction := delta / distance
	var shaft_start := start + direction * minf(float(badge_radius + 2), distance * 0.35)
	_raster_line(image, shaft_start, end, color, stroke_width)
	var head_size := clampf(distance * 0.12, float(stroke_width * 3), float(badge_radius + stroke_width))
	_raster_line(image, end, end - direction.rotated(0.58) * head_size, color, stroke_width)
	_raster_line(image, end, end - direction.rotated(-0.58) * head_size, color, stroke_width)


func _raster_rectangle(image: Image, bounds: Rect2, color: Color, stroke_width: int) -> void:
	var top_left := bounds.position
	var top_right := Vector2(bounds.end.x, bounds.position.y)
	var bottom_right := bounds.end
	var bottom_left := Vector2(bounds.position.x, bounds.end.y)
	_raster_line(image, top_left, top_right, color, stroke_width)
	_raster_line(image, top_right, bottom_right, color, stroke_width)
	_raster_line(image, bottom_right, bottom_left, color, stroke_width)
	_raster_line(image, bottom_left, top_left, color, stroke_width)


func _raster_ellipse(image: Image, bounds: Rect2, color: Color, stroke_width: int) -> void:
	if bounds.size.x <= 0.001 or bounds.size.y <= 0.001:
		return
	var center := bounds.get_center()
	var radius := bounds.size * 0.5
	var circumference := TAU * sqrt((radius.x * radius.x + radius.y * radius.y) * 0.5)
	var steps := clampi(int(ceil(circumference)), 32, 4096)
	var previous := center + Vector2(radius.x, 0.0)
	for index in range(1, steps + 1):
		var angle := TAU * float(index) / float(steps)
		var current := center + Vector2(cos(angle) * radius.x, sin(angle) * radius.y)
		_raster_line(image, previous, current, color, stroke_width)
		previous = current


func _raster_line(
	image: Image,
	start: Vector2,
	end: Vector2,
	color: Color,
	stroke_width: int
) -> void:
	var distance := start.distance_to(end)
	var steps := maxi(1, int(ceil(distance)))
	var radius := maxi(1, int(ceil(float(stroke_width) * 0.5)))
	for index in range(steps + 1):
		var point := start.lerp(end, float(index) / float(steps))
		_raster_disc(image, Vector2i(roundi(point.x), roundi(point.y)), radius, color)


func _raster_disc(image: Image, center: Vector2i, radius: int, color: Color) -> void:
	var radius_squared := radius * radius
	for y in range(center.y - radius, center.y + radius + 1):
		if y < 0 or y >= image.get_height():
			continue
		for x in range(center.x - radius, center.x + radius + 1):
			if x < 0 or x >= image.get_width():
				continue
			var offset_x := x - center.x
			var offset_y := y - center.y
			if offset_x * offset_x + offset_y * offset_y <= radius_squared:
				image.set_pixel(x, y, color)


func _raster_number_badge(
	image: Image,
	center: Vector2,
	annotation_id: int,
	color: Color,
	badge_radius: int
) -> void:
	_raster_disc(
		image,
		Vector2i(roundi(center.x), roundi(center.y)),
		badge_radius,
		color
	)
	var digits := str(annotation_id)
	var digit_scale := maxi(1, int(floor(float(badge_radius) / 6.0)))
	var digit_width := 3 * digit_scale
	var spacing := digit_scale
	var total_width := digits.length() * digit_width + maxi(0, digits.length() - 1) * spacing
	var total_height := 5 * digit_scale
	var origin := Vector2i(
		roundi(center.x - float(total_width) * 0.5),
		roundi(center.y - float(total_height) * 0.5)
	)
	for digit_index in range(digits.length()):
		var digit := digits.substr(digit_index, 1)
		var pattern_value: Variant = DIGIT_PATTERNS.get(digit)
		if not pattern_value is Array:
			continue
		var pattern := pattern_value as Array
		for row_index in range(pattern.size()):
			var row := str(pattern[row_index])
			for column_index in range(3):
				if row.substr(column_index, 1) != "1":
					continue
				var cell_origin := origin + Vector2i(
					digit_index * (digit_width + spacing) + column_index * digit_scale,
					row_index * digit_scale
				)
				_raster_fill_rect(
					image,
					Rect2i(cell_origin, Vector2i(digit_scale, digit_scale)),
					Color.WHITE
				)


func _raster_fill_rect(image: Image, bounds: Rect2i, color: Color) -> void:
	var start_x := maxi(0, bounds.position.x)
	var start_y := maxi(0, bounds.position.y)
	var end_x := mini(image.get_width(), bounds.end.x)
	var end_y := mini(image.get_height(), bounds.end.y)
	for y in range(start_y, end_y):
		for x in range(start_x, end_x):
			image.set_pixel(x, y, color)


func _sanitize_annotation(value: Dictionary) -> Dictionary:
	var annotation_id := int(value.get("id", 0))
	var annotation_type := str(value.get("type", "")).strip_edges().to_lower()
	var start_value: Variant = value.get("start")
	var end_value: Variant = value.get("end")
	if (
		annotation_id < 1
		or annotation_id > MAX_ANNOTATIONS
		or not ANNOTATION_TYPES.has(annotation_type)
		or not _is_point_value(start_value)
		or not _is_point_value(end_value)
	):
		return {}
	var start := _clamp_normalized(_point_from_value(start_value))
	var end := _clamp_normalized(_point_from_value(end_value))
	if annotation_type != "arrow":
		var bounds := _rect_from_points(start, end)
		start = bounds.position
		end = bounds.end
	if not _has_valid_geometry(annotation_type, start, end):
		return {}
	return {
		"id": annotation_id,
		"type": annotation_type,
		"start": _point_array(start),
		"end": _point_array(end),
	}


func _push_history() -> void:
	_history.append(get_annotations())
	if _history.size() > MAX_HISTORY_ENTRIES:
		_history.remove_at(0)


func _recalculate_next_id() -> void:
	var used_ids := {}
	for annotation in _annotations:
		used_ids[int(annotation.get("id", 0))] = true
	_next_id = 1
	while _next_id <= MAX_ANNOTATIONS and used_ids.has(_next_id):
		_next_id += 1


func _annotation_start(annotation: Dictionary) -> Vector2:
	return _point_from_value(annotation.get("start"))


func _annotation_end(annotation: Dictionary) -> Vector2:
	return _point_from_value(annotation.get("end"))


static func _point_from_value(value: Variant) -> Vector2:
	if not _is_point_value(value):
		return INVALID_NORMALIZED_POINT
	var coordinates := value as Array
	return Vector2(float(coordinates[0]), float(coordinates[1]))


static func _is_point_value(value: Variant) -> bool:
	if not value is Array:
		return false
	var coordinates := value as Array
	if coordinates.size() != 2:
		return false
	var x_value: Variant = coordinates[0]
	var y_value: Variant = coordinates[1]
	if not (x_value is int or x_value is float) or not (y_value is int or y_value is float):
		return false
	return is_finite(float(x_value)) and is_finite(float(y_value))


static func _point_array(point: Vector2) -> Array:
	return [float(point.x), float(point.y)]


static func _clamp_normalized(point: Vector2) -> Vector2:
	return Vector2(clampf(point.x, 0.0, 1.0), clampf(point.y, 0.0, 1.0))


static func _is_finite_point(point: Vector2) -> bool:
	return is_finite(point.x) and is_finite(point.y)


static func _has_valid_geometry(type_name: String, start: Vector2, end: Vector2) -> bool:
	var delta := (end - start).abs()
	if type_name == "arrow":
		return delta.length_squared() > 0.0000000001
	return delta.x > 0.00001 and delta.y > 0.00001


static func _rect_from_points(first: Vector2, second: Vector2) -> Rect2:
	var position := Vector2(minf(first.x, second.x), minf(first.y, second.y))
	var end := Vector2(maxf(first.x, second.x), maxf(first.y, second.y))
	return Rect2(position, end - position)


static func _clamp_to_rect(point: Vector2, bounds: Rect2) -> Vector2:
	return Vector2(
		clampf(point.x, bounds.position.x, bounds.end.x),
		clampf(point.y, bounds.position.y, bounds.end.y)
	)


static func _tool_name(mode: int) -> String:
	match mode:
		ToolMode.RECTANGLE:
			return "rectangle"
		ToolMode.CIRCLE:
			return "circle"
	return "arrow"
