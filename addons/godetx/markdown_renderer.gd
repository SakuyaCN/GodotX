@tool
extends RefCounted

const MAX_TABLE_COLUMNS := 8
const MAX_TABLE_ROWS := 100
const MAX_CELL_LENGTH := 2048
const MAX_LINK_LENGTH := 2048
const MAX_INLINE_DEPTH := 8
const HORIZONTAL_RULE_WIDTH := 48


static func render(body: RichTextLabel, source: String, palette: Dictionary = {}) -> void:
	body.clear()
	var lines: PackedStringArray = source.split("\n", true)
	var index := 0
	while index < lines.size():
		var line := str(lines[index])
		var fence := _fence_marker(line)
		if not fence.is_empty():
			var code_lines := PackedStringArray()
			index += 1
			while index < lines.size() and not str(lines[index]).strip_edges().begins_with(fence):
				code_lines.append(str(lines[index]))
				index += 1
			if index < lines.size():
				index += 1
			_render_code_block(body, "\n".join(code_lines), palette)
			_append_line_break(body, index, lines.size())
			continue

		if index + 1 < lines.size() and _can_start_table(line, str(lines[index + 1])):
			var table_result := _read_table(lines, index)
			if bool(table_result.get("ok", false)):
				_render_table(
					body,
					table_result.get("rows", []),
					table_result.get("alignments", PackedStringArray()),
					palette
				)
				var omitted_rows := int(table_result.get("omitted_rows", 0))
				if omitted_rows > 0:
					body.add_text("\n")
					body.push_color(_palette_color(palette, "muted", Color("9297a1")))
					body.add_text(
						str(palette.get("table_rows_omitted", "%d table rows omitted.")) % omitted_rows
					)
					body.pop()
				index = int(table_result.get("next_index", index + 1))
				_append_line_break(body, index, lines.size())
				continue

		var heading_level := _heading_level(line)
		if heading_level > 0:
			_render_heading(
				body,
				line.strip_edges().substr(heading_level + 1),
				heading_level,
				palette
			)
		elif _is_horizontal_rule(line):
			body.push_color(_palette_color(palette, "border", Color("5a5d64")))
			body.add_text("-".repeat(HORIZONTAL_RULE_WIDTH))
			body.pop()
		elif _is_unordered_list_item(line):
			body.push_indent(1)
			body.add_text("• ")
			_render_inline(body, line.strip_edges().substr(2), palette)
			body.pop()
		else:
			var ordered_item := _ordered_list_item(line)
			if not ordered_item.is_empty():
				body.push_indent(1)
				body.add_text("%s. " % str(ordered_item.get("number", "1")))
				_render_inline(body, str(ordered_item.get("content", "")), palette)
				body.pop()
			elif line.strip_edges().begins_with(">"):
				var quote_text := line.strip_edges().trim_prefix(">").strip_edges()
				body.push_indent(1)
				body.push_color(_palette_color(palette, "muted", Color("9297a1")))
				body.add_text("| ")
				_render_inline(body, quote_text, palette)
				body.pop()
				body.pop()
			else:
				_render_inline(body, line, palette)
		index += 1
		_append_line_break(body, index, lines.size())


static func is_safe_link(value: String) -> bool:
	var url := value.strip_edges()
	if url.is_empty() or url.length() > MAX_LINK_LENGTH:
		return false
	if not (url.begins_with("https://") or url.begins_with("http://")):
		return false
	for index in range(url.length()):
		var codepoint := url.unicode_at(index)
		if codepoint < 32 or codepoint == 127:
			return false
	return true


static func _render_heading(
	body: RichTextLabel,
	text: String,
	level: int,
	palette: Dictionary
) -> void:
	var sizes := PackedInt32Array([22, 20, 18, 16, 15, 14])
	body.push_font_size(sizes[mini(level - 1, sizes.size() - 1)])
	body.push_bold()
	body.push_color(_palette_color(palette, "heading", Color("e6e7e9")))
	_render_inline(body, text.strip_edges(), palette)
	body.pop()
	body.pop()
	body.pop()


static func _render_code_block(body: RichTextLabel, text: String, palette: Dictionary) -> void:
	body.push_bgcolor(_palette_color(palette, "code_background", Color("18191d")))
	body.push_color(_palette_color(palette, "code", Color("d6d9df")))
	body.push_mono()
	body.add_text(text)
	body.pop()
	body.pop()
	body.pop()


static func _render_table(
	body: RichTextLabel,
	rows_value: Variant,
	alignments_value: Variant,
	palette: Dictionary
) -> void:
	if not rows_value is Array:
		return
	var rows: Array = rows_value
	if rows.is_empty():
		return
	var header_value = rows[0]
	if not header_value is PackedStringArray:
		return
	var header: PackedStringArray = header_value
	var column_count := header.size()
	if column_count <= 0 or column_count > MAX_TABLE_COLUMNS:
		return
	var alignments := PackedStringArray()
	if alignments_value is PackedStringArray:
		alignments = alignments_value

	body.push_table(column_count)
	for column in range(column_count):
		body.set_table_column_expand(column, true, 1, true)
		body.set_table_column_name(column, str(header[column]).left(128))

	for row_index in range(rows.size()):
		var row_value = rows[row_index]
		if not row_value is PackedStringArray:
			continue
		var row: PackedStringArray = row_value
		for column in range(column_count):
			var cell_text := str(row[column]) if column < row.size() else ""
			body.push_cell()
			body.set_cell_padding(Rect2(7.0, 4.0, 7.0, 4.0))
			body.set_cell_border_color(_palette_color(palette, "border", Color("555860")))
			if row_index == 0:
				var header_background := _palette_color(
					palette,
					"table_header_background",
					Color("34373d")
				)
				body.set_cell_row_background_color(header_background, header_background)
			else:
				body.set_cell_row_background_color(
					_palette_color(palette, "table_odd_background", Color("25272c")),
					_palette_color(palette, "table_even_background", Color("202227"))
				)

			var alignment := HORIZONTAL_ALIGNMENT_LEFT
			if column < alignments.size():
				if alignments[column] == "center":
					alignment = HORIZONTAL_ALIGNMENT_CENTER
				elif alignments[column] == "right":
					alignment = HORIZONTAL_ALIGNMENT_RIGHT
			body.push_paragraph(alignment)
			if row_index == 0:
				body.push_bold()
			_render_inline(body, cell_text.left(MAX_CELL_LENGTH), palette)
			if row_index == 0:
				body.pop()
			body.pop()
			body.pop()
	body.pop()


static func _render_inline(
	body: RichTextLabel,
	text: String,
	palette: Dictionary,
	depth: int = 0
) -> void:
	if depth >= MAX_INLINE_DEPTH:
		body.add_text(text)
		return
	var plain := ""
	var index := 0
	while index < text.length():
		var current := text.substr(index, 1)
		if current == "\\" and index + 1 < text.length():
			var escaped := text.substr(index + 1, 1)
			if "\\`*_[]|~".contains(escaped):
				plain += escaped
				index += 2
				continue

		if current == "`":
			var code_end := text.find("`", index + 1)
			if code_end >= 0:
				_flush_plain(body, plain)
				plain = ""
				body.push_bgcolor(_palette_color(palette, "inline_code_background", Color("2d3036")))
				body.push_mono()
				body.add_text(text.substr(index + 1, code_end - index - 1))
				body.pop()
				body.pop()
				index = code_end + 1
				continue

		if index + 1 < text.length() and text.substr(index, 2) == "**":
			var bold_end := text.find("**", index + 2)
			if bold_end >= 0:
				_flush_plain(body, plain)
				plain = ""
				body.push_bold()
				_render_inline(body, text.substr(index + 2, bold_end - index - 2), palette, depth + 1)
				body.pop()
				index = bold_end + 2
				continue

		if index + 1 < text.length() and text.substr(index, 2) == "~~":
			var strike_end := text.find("~~", index + 2)
			if strike_end >= 0:
				_flush_plain(body, plain)
				plain = ""
				body.push_strikethrough()
				_render_inline(body, text.substr(index + 2, strike_end - index - 2), palette, depth + 1)
				body.pop()
				index = strike_end + 2
				continue

		if (current == "*" or current == "_") and _can_open_italic(text, index, current):
			var italic_end := text.find(current, index + 1)
			if italic_end > index + 1 and _can_close_italic(text, italic_end, current):
				_flush_plain(body, plain)
				plain = ""
				body.push_italics()
				_render_inline(body, text.substr(index + 1, italic_end - index - 1), palette, depth + 1)
				body.pop()
				index = italic_end + 1
				continue

		if current == "[":
			var label_end := text.find("](", index + 1)
			if label_end > index + 1:
				var url_end := text.find(")", label_end + 2)
				if url_end > label_end + 2:
					var url := text.substr(label_end + 2, url_end - label_end - 2).strip_edges()
					if is_safe_link(url):
						_flush_plain(body, plain)
						plain = ""
						body.push_meta(url, RichTextLabel.META_UNDERLINE_ON_HOVER, url)
						body.push_color(_palette_color(palette, "link", Color("72a7ff")))
						_render_inline(
							body,
							text.substr(index + 1, label_end - index - 1),
							palette,
							depth + 1
						)
						body.pop()
						body.pop()
						index = url_end + 1
						continue

		plain += current
		index += 1
	_flush_plain(body, plain)


static func _flush_plain(body: RichTextLabel, text: String) -> void:
	if not text.is_empty():
		body.add_text(text)


static func _read_table(lines: PackedStringArray, start_index: int) -> Dictionary:
	var header := _split_table_row(str(lines[start_index]))
	var delimiter := _split_table_row(str(lines[start_index + 1]))
	if header.size() < 2 or header.size() > MAX_TABLE_COLUMNS:
		return {"ok": false}
	if delimiter.size() != header.size() or not _is_delimiter_row(delimiter):
		return {"ok": false}

	var alignments := PackedStringArray()
	for cell in delimiter:
		var stripped := str(cell).strip_edges()
		if stripped.begins_with(":") and stripped.ends_with(":"):
			alignments.append("center")
		elif stripped.ends_with(":"):
			alignments.append("right")
		else:
			alignments.append("left")

	var rows: Array = [header]
	var omitted_rows := 0
	var index := start_index + 2
	while index < lines.size():
		var row_line := str(lines[index])
		if row_line.strip_edges().is_empty() or not row_line.contains("|"):
			break
		var cells := _split_table_row(row_line)
		if cells.size() < 2:
			break
		if rows.size() < MAX_TABLE_ROWS + 1:
			var normalized := PackedStringArray()
			for column in range(header.size()):
				normalized.append(str(cells[column]) if column < cells.size() else "")
			rows.append(normalized)
		else:
			omitted_rows += 1
		index += 1
	return {
		"ok": true,
		"rows": rows,
		"alignments": alignments,
		"omitted_rows": omitted_rows,
		"next_index": index,
	}


static func _can_start_table(header_line: String, delimiter_line: String) -> bool:
	if not header_line.contains("|") or not delimiter_line.contains("|"):
		return false
	var header := _split_table_row(header_line)
	var delimiter := _split_table_row(delimiter_line)
	return (
		header.size() >= 2
		and header.size() <= MAX_TABLE_COLUMNS
		and delimiter.size() == header.size()
		and _is_delimiter_row(delimiter)
	)


static func _split_table_row(line: String) -> PackedStringArray:
	var value := line.strip_edges()
	if value.begins_with("|"):
		value = value.substr(1)
	if value.ends_with("|") and not value.ends_with("\\|"):
		value = value.left(value.length() - 1)

	var cells := PackedStringArray()
	var current := ""
	var escaped := false
	var in_code := false
	for index in range(value.length()):
		var character := value.substr(index, 1)
		if escaped:
			current += character
			escaped = false
		elif character == "\\":
			var next_character := value.substr(index + 1, 1) if index + 1 < value.length() else ""
			if next_character == "|" or next_character == "\\" or next_character == "`":
				escaped = true
			else:
				current += character
		elif character == "`":
			in_code = not in_code
			current += character
		elif character == "|" and not in_code:
			cells.append(current.strip_edges().left(MAX_CELL_LENGTH))
			current = ""
		else:
			current += character
	if escaped:
		current += "\\"
	cells.append(current.strip_edges().left(MAX_CELL_LENGTH))
	return cells


static func _is_delimiter_row(cells: PackedStringArray) -> bool:
	for cell in cells:
		var value := str(cell).strip_edges()
		if value.begins_with(":"):
			value = value.substr(1)
		if value.ends_with(":"):
			value = value.left(value.length() - 1)
		if value.length() < 3:
			return false
		for index in range(value.length()):
			if value.substr(index, 1) != "-":
				return false
	return true


static func _heading_level(line: String) -> int:
	var stripped := line.strip_edges()
	var level := 0
	while level < mini(6, stripped.length()) and stripped.substr(level, 1) == "#":
		level += 1
	if level == 0 or level >= stripped.length() or stripped.substr(level, 1) != " ":
		return 0
	return level


static func _fence_marker(line: String) -> String:
	var stripped := line.strip_edges()
	if stripped.begins_with("```"):
		return "```"
	if stripped.begins_with("~~~"):
		return "~~~"
	return ""


static func _is_horizontal_rule(line: String) -> bool:
	var compact := line.strip_edges().replace(" ", "")
	if compact.length() < 3:
		return false
	var marker := compact.substr(0, 1)
	if marker != "-" and marker != "*" and marker != "_":
		return false
	for index in range(compact.length()):
		if compact.substr(index, 1) != marker:
			return false
	return true


static func _is_unordered_list_item(line: String) -> bool:
	var stripped := line.strip_edges()
	return stripped.begins_with("- ") or stripped.begins_with("* ") or stripped.begins_with("+ ")


static func _ordered_list_item(line: String) -> Dictionary:
	var stripped := line.strip_edges()
	var separator := stripped.find(". ")
	if separator <= 0:
		return {}
	var number := stripped.left(separator)
	if not number.is_valid_int() or number.length() > 6:
		return {}
	return {"number": number, "content": stripped.substr(separator + 2)}


static func _can_open_italic(text: String, index: int, marker: String) -> bool:
	if index + 1 >= text.length() or text.substr(index + 1, 1).strip_edges().is_empty():
		return false
	if marker == "_" and index > 0 and _is_word_character(text.substr(index - 1, 1)):
		return false
	return true


static func _can_close_italic(text: String, index: int, marker: String) -> bool:
	if marker == "_" and index + 1 < text.length() and _is_word_character(text.substr(index + 1, 1)):
		return false
	return true


static func _is_word_character(value: String) -> bool:
	if value.is_empty():
		return false
	var codepoint := value.unicode_at(0)
	return (
		(codepoint >= 48 and codepoint <= 57)
		or (codepoint >= 65 and codepoint <= 90)
		or (codepoint >= 97 and codepoint <= 122)
		or codepoint >= 128
	)


static func _append_line_break(body: RichTextLabel, index: int, total: int) -> void:
	if index < total:
		body.add_text("\n")


static func _palette_color(palette: Dictionary, key: String, fallback: Color) -> Color:
	var value = palette.get(key, fallback)
	return value if value is Color else fallback
