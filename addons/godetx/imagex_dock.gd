@tool
extends VBoxContainer

const Localization := preload("res://addons/godetx/localization.gd")
const AttachmentStore := preload("res://addons/godetx/attachment_store.gd")
const ResourceDropTarget := preload("res://addons/godetx/resource_drop_target.gd")
const ICON_SETTINGS := preload("res://addons/godetx/icons/settings.svg")
const ICON_GENERATE := preload("res://addons/godetx/icons/send.svg")
const ICON_STOP := preload("res://addons/godetx/icons/stop.svg")
const ICON_FILE := preload("res://addons/godetx/icons/file.svg")

const DEFAULT_MODEL := "gpt-image-2"
const DEFAULT_SIZES := ["1024x1024", "1536x1024", "1024x1536"]
const DEFAULT_QUALITIES := ["auto", "low", "medium", "high"]
const DEFAULT_BACKGROUNDS := ["auto", "opaque", "transparent"]
const DEFAULT_FORMATS := ["png", "jpeg", "webp"]
const TASK_SINGLE := "single"
const TASK_UI_KIT := "ui_kit"
const TASK_RESKIN := "reskin"
const TASK_ATLAS_VARIATION := "atlas_variation"
const CUSTOM_SIZE := "custom"
const MIN_OUTPUT_SIZE := 16
const MAX_OUTPUT_SIZE := 3840
const MIN_SPRITE_SOURCE_SIZE := 16
const MAX_SPRITE_SOURCE_SIZE := 2048
const MAX_ATLAS_FRAMES := 256
const MAX_IMAGE_EDIT_PROMPT_CHARACTERS := 8000

var editor_interface: EditorInterface
var godetx_dock

var _status: Label
var _provider: Label
var _preview: TextureRect
var _preview_placeholder: Label
var _result_scroll: ScrollContainer
var _task_tabs: TabContainer
var _single_prompt: TextEdit
var _ui_kit_prompt: TextEdit
var _reskin_prompt: TextEdit
var _atlas_prompt: TextEdit
var _common_options: GridContainer
var _single_options: GridContainer
var _ui_kit_options: GridContainer
var _atlas_options: GridContainer
var _model: OptionButton
var _size: OptionButton
var _custom_size_row: HBoxContainer
var _custom_width: SpinBox
var _custom_height: SpinBox
var _quality: OptionButton
var _background: OptionButton
var _format: OptionButton
var _asset_count: OptionButton
var _capture_viewport: CheckButton
var _vision_review: CheckButton
var _generate_button: Button
var _stop_button: Button
var _locate_button: Button
var _result_path: Label
var _asset_result_select: OptionButton
var _workflow_details: TextEdit
var _source_file_dialog: EditorFileDialog
var _source_dialog_task_mode := ""
var _source_import_token := 0
var _reskin_source_attachment: Dictionary = {}
var _atlas_source_attachment: Dictionary = {}
var _reskin_source_preview: TextureRect
var _atlas_source_preview: TextureRect
var _reskin_source_placeholder: Label
var _atlas_source_placeholder: Label
var _reskin_source_label: Label
var _atlas_source_label: Label
var _reskin_source_button: Button
var _atlas_source_button: Button
var _reskin_source_drop_target
var _atlas_source_drop_target
var _atlas_columns: SpinBox
var _atlas_rows: SpinBox
var _atlas_frame_summary: Label

var _active_generation_id := ""
var _active_task_mode := ""
var _cancelling := false
var _result_resource_path := ""
var _last_fingerprint := ""
var _planner_model := ""
var _capabilities_requested := false
var _capabilities_received := false
var _image_supported := false
var _image_edit_supported := false
var _image_edit_unavailable_message := "Provider does not support image editing"
var _max_prompt_characters := 32_000
var _last_status_key := ""
var _transient_status_until_ms := 0
var _result_status_text := ""
var _result_status_color := Color("72c98a")
var _result_status_literal := false
var _last_result_preview_loaded := false
var _next_state_poll_ms := 0
var _shutting_down := false
var _ui_kit_assets: Array[Dictionary] = []
var _workflow_plan_text := ""
var _pending_resource_imports: Dictionary = {}
var _model_source_sizes: Array[String] = []
var _generation_models: Array[String] = []
var _edit_models: Array[String] = []
var _default_image_model := DEFAULT_MODEL


func _ready() -> void:
	name = "ImageXDock"
	size_flags_horizontal = Control.SIZE_EXPAND_FILL
	size_flags_vertical = Control.SIZE_EXPAND_FILL
	set_process(true)
	_build_ui()
	_connect_runtime_signals()
	_populate_defaults()
	_update_runtime_state()
	call_deferred("_scan_generated_directory")


func shutdown() -> void:
	if _shutting_down:
		return
	_shutting_down = true
	set_process(false)
	_source_import_token += 1
	_pending_resource_imports.clear()
	if not _active_generation_id.is_empty() and godetx_dock != null:
		godetx_dock.call("cancel_image_generation", _active_generation_id)
	_disconnect_runtime_signals()


func _process(_delta: float) -> void:
	if _shutting_down:
		return
	var now := Time.get_ticks_msec()
	if now < _next_state_poll_ms:
		return
	_next_state_poll_ms = now + 250
	_update_runtime_state()


func _build_ui() -> void:
	add_theme_constant_override("separation", 8)

	var header := HBoxContainer.new()
	header.add_theme_constant_override("separation", 8)
	add_child(header)

	var title := Label.new()
	title.text = "ImageX"
	title.add_theme_font_size_override("font_size", 16)
	header.add_child(title)

	_provider = Label.new()
	_provider.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_provider.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	_provider.add_theme_color_override("font_color", Color("8f98a3"))
	header.add_child(_provider)

	var settings_button := Button.new()
	settings_button.icon = ICON_SETTINGS
	settings_button.flat = true
	settings_button.custom_minimum_size = Vector2(32, 32)
	settings_button.tooltip_text = _t("Connection settings")
	settings_button.pressed.connect(_open_settings)
	header.add_child(settings_button)

	_status = Label.new()
	_status.text = _t("Waiting for runtime")
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_status.add_theme_color_override("font_color", Color("d5a15d"))
	add_child(_status)

	_result_scroll = ScrollContainer.new()
	_result_scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_result_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	add_child(_result_scroll)

	var body := VBoxContainer.new()
	body.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	body.add_theme_constant_override("separation", 8)
	_result_scroll.add_child(body)

	var preview_panel := PanelContainer.new()
	preview_panel.custom_minimum_size = Vector2(0, 260)
	preview_panel.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	preview_panel.add_theme_stylebox_override("panel", _preview_style())
	body.add_child(preview_panel)

	_preview = TextureRect.new()
	_preview.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_preview.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	_preview.mouse_filter = Control.MOUSE_FILTER_IGNORE
	preview_panel.add_child(_preview)

	var preview_center := CenterContainer.new()
	preview_center.mouse_filter = Control.MOUSE_FILTER_IGNORE
	preview_panel.add_child(preview_center)
	_preview_placeholder = Label.new()
	_preview_placeholder.text = _t("Generated image preview")
	_preview_placeholder.add_theme_color_override("font_color", Color("69727d"))
	preview_center.add_child(_preview_placeholder)

	_asset_result_select = OptionButton.new()
	_asset_result_select.visible = false
	_asset_result_select.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_asset_result_select.item_selected.connect(_on_asset_result_selected)
	body.add_child(_asset_result_select)

	var result_row := HBoxContainer.new()
	result_row.add_theme_constant_override("separation", 6)
	body.add_child(result_row)
	_result_path = Label.new()
	_result_path.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_result_path.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	_result_path.add_theme_color_override("font_color", Color("8f98a3"))
	result_row.add_child(_result_path)
	_locate_button = Button.new()
	_locate_button.icon = ICON_FILE
	_locate_button.flat = true
	_locate_button.disabled = true
	_locate_button.custom_minimum_size = Vector2(30, 30)
	_locate_button.tooltip_text = _t("Show generated image in FileSystem")
	_locate_button.pressed.connect(_locate_result)
	result_row.add_child(_locate_button)

	var settings_label := Label.new()
	settings_label.text = _t("Generation settings")
	settings_label.add_theme_font_size_override("font_size", 13)
	settings_label.add_theme_color_override("font_color", Color("c2c9d2"))
	body.add_child(settings_label)

	_common_options = _new_option_grid()
	body.add_child(_common_options)
	_model = _add_option(_common_options, "Image model")
	_size = _add_option(_common_options, "Size")
	_size.item_selected.connect(_on_size_selected)
	_add_custom_size_controls(_common_options)
	_quality = _add_option(_common_options, "Quality")
	_background = _add_option(_common_options, "Background")
	_background.item_selected.connect(_on_background_selected)

	_task_tabs = TabContainer.new()
	_task_tabs.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_task_tabs.size_flags_vertical = Control.SIZE_SHRINK_BEGIN
	_task_tabs.custom_minimum_size = Vector2(0, 238)
	_task_tabs.use_hidden_tabs_for_min_size = false
	_configure_task_tab_theme()
	body.add_child(_task_tabs)

	var ui_kit_page := _add_task_tab("AI UI kit", TASK_UI_KIT, "UI kit")
	_ui_kit_prompt = _add_prompt(ui_kit_page, "Describe the UI kit needed for the current scene")
	_ui_kit_options = _new_option_grid()
	ui_kit_page.add_child(_ui_kit_options)
	_asset_count = _add_option(_ui_kit_options, "Asset count")
	_replace_options(_asset_count, ["2", "3", "4"], "3")
	_capture_viewport = _add_check(_ui_kit_options, "Scene context", "Use current 2D viewport")
	_capture_viewport.button_pressed = true
	_vision_review = _add_check(
		_ui_kit_options,
		"Quality check",
		"Review generated kit with the planner model"
	)
	_vision_review.button_pressed = true

	_workflow_details = TextEdit.new()
	_workflow_details.visible = false
	_workflow_details.editable = false
	_workflow_details.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	_workflow_details.custom_minimum_size = Vector2(0, 120)
	_workflow_details.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_workflow_details.size_flags_vertical = Control.SIZE_SHRINK_BEGIN
	_workflow_details.add_theme_color_override("font_readonly_color", Color("c2c9d2"))
	ui_kit_page.add_child(_workflow_details)

	var single_page := _add_task_tab("Single image", TASK_SINGLE, "Single image")
	_single_prompt = _add_prompt(single_page, "Describe the image to generate")
	_single_options = _new_option_grid()
	single_page.add_child(_single_options)
	_format = _add_option(_single_options, "Format")
	_format.item_selected.connect(_on_format_selected)

	var reskin_page := _add_task_tab("Sprite reskin", TASK_RESKIN, "Sprite reskin")
	_add_source_picker(reskin_page, TASK_RESKIN)
	_reskin_prompt = _add_prompt(reskin_page, "Describe the new sprite skin")

	var atlas_page := _add_task_tab(
		"Atlas variation",
		TASK_ATLAS_VARIATION,
		"Atlas variation"
	)
	_add_source_picker(atlas_page, TASK_ATLAS_VARIATION)
	_atlas_prompt = _add_prompt(atlas_page, "Describe the new atlas variation")
	_atlas_options = _new_option_grid()
	atlas_page.add_child(_atlas_options)
	_atlas_columns = _add_atlas_dimension(_atlas_options, "Columns")
	_atlas_rows = _add_atlas_dimension(_atlas_options, "Rows")
	_atlas_columns.value = 4.0
	_atlas_rows.value = 4.0
	_atlas_columns.value_changed.connect(_on_atlas_grid_changed)
	_atlas_rows.value_changed.connect(_on_atlas_grid_changed)
	_atlas_frame_summary = Label.new()
	_atlas_frame_summary.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_atlas_frame_summary.add_theme_color_override("font_color", Color("8f98a3"))
	atlas_page.add_child(_atlas_frame_summary)

	_source_file_dialog = EditorFileDialog.new()
	_source_file_dialog.title = _t("Select source image")
	_source_file_dialog.access = FileDialog.ACCESS_RESOURCES
	_source_file_dialog.file_mode = FileDialog.FILE_MODE_OPEN_FILE
	_source_file_dialog.add_filter(
		"*.png, *.jpg, *.jpeg, *.webp, *.bmp, *.tga, *.svg",
		_t("Project images")
	)
	_source_file_dialog.file_selected.connect(_on_source_file_selected)
	add_child(_source_file_dialog)

	_task_tabs.current_tab = 0
	_task_tabs.tab_changed.connect(_on_task_mode_selected)
	resized.connect(_update_option_layout_columns)
	_update_option_layout_columns()

	var actions := HBoxContainer.new()
	actions.add_theme_constant_override("separation", 6)
	add_child(actions)
	_generate_button = Button.new()
	_generate_button.text = _t("Generate")
	_generate_button.icon = ICON_GENERATE
	_generate_button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_generate_button.custom_minimum_size = Vector2(0, 36)
	_generate_button.pressed.connect(_generate)
	actions.add_child(_generate_button)
	_stop_button = Button.new()
	_stop_button.icon = ICON_STOP
	_stop_button.disabled = true
	_stop_button.custom_minimum_size = Vector2(36, 36)
	_stop_button.tooltip_text = _t("Cancel image generation")
	_stop_button.pressed.connect(_cancel_generation)
	actions.add_child(_stop_button)
	_on_task_mode_selected(0)


func _add_task_tab(title: String, task_mode: String, node_name: String) -> VBoxContainer:
	var page := MarginContainer.new()
	page.name = node_name
	page.set_meta("task_mode", task_mode)
	page.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	page.add_theme_constant_override("margin_left", 8)
	page.add_theme_constant_override("margin_top", 8)
	page.add_theme_constant_override("margin_right", 8)
	page.add_theme_constant_override("margin_bottom", 8)
	_task_tabs.add_child(page)
	_task_tabs.set_tab_title(_task_tabs.get_tab_count() - 1, _t(title))
	var content := VBoxContainer.new()
	content.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	content.add_theme_constant_override("separation", 8)
	page.add_child(content)
	return content


func _add_prompt(parent: VBoxContainer, placeholder: String) -> TextEdit:
	var label := Label.new()
	label.text = _t("Prompt")
	parent.add_child(label)
	var prompt := TextEdit.new()
	prompt.custom_minimum_size = Vector2(0, 96)
	prompt.placeholder_text = _t(placeholder)
	prompt.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	prompt.gui_input.connect(_on_prompt_gui_input.bind(prompt))
	parent.add_child(prompt)
	return prompt


func _add_source_picker(parent: VBoxContainer, task_mode: String) -> void:
	var heading := Label.new()
	heading.text = _t("Source sprite" if task_mode == TASK_RESKIN else "Source atlas")
	parent.add_child(heading)

	var panel := ResourceDropTarget.new()
	panel.custom_minimum_size = Vector2(0, 132)
	panel.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	panel.add_theme_stylebox_override("panel", _preview_style())
	panel.tooltip_text = _t("Drop one project image here")
	panel.resource_paths_dropped.connect(_on_source_paths_dropped.bind(task_mode))
	parent.add_child(panel)

	var preview := TextureRect.new()
	preview.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	preview.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	preview.mouse_filter = Control.MOUSE_FILTER_IGNORE
	panel.add_child(preview)

	var center := CenterContainer.new()
	center.mouse_filter = Control.MOUSE_FILTER_IGNORE
	panel.add_child(center)
	var placeholder := Label.new()
	placeholder.text = _t("Source image preview")
	placeholder.mouse_filter = Control.MOUSE_FILTER_IGNORE
	placeholder.add_theme_color_override("font_color", Color("69727d"))
	center.add_child(placeholder)

	var source_row := HBoxContainer.new()
	source_row.add_theme_constant_override("separation", 6)
	parent.add_child(source_row)
	var source_label := Label.new()
	source_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	source_label.text = _t("No source image selected")
	source_label.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	source_label.add_theme_color_override("font_color", Color("8f98a3"))
	source_row.add_child(source_label)
	var select_button := Button.new()
	select_button.text = _t("Select project image")
	select_button.icon = ICON_FILE
	select_button.pressed.connect(_open_source_file_dialog.bind(task_mode))
	source_row.add_child(select_button)

	if task_mode == TASK_RESKIN:
		_reskin_source_drop_target = panel
		_reskin_source_preview = preview
		_reskin_source_placeholder = placeholder
		_reskin_source_label = source_label
		_reskin_source_button = select_button
	else:
		_atlas_source_drop_target = panel
		_atlas_source_preview = preview
		_atlas_source_placeholder = placeholder
		_atlas_source_label = source_label
		_atlas_source_button = select_button


func _add_atlas_dimension(parent: GridContainer, label_text: String) -> SpinBox:
	var label := Label.new()
	label.text = _t(label_text)
	parent.add_child(label)
	var spin := SpinBox.new()
	spin.min_value = 1.0
	spin.max_value = float(MAX_ATLAS_FRAMES)
	spin.step = 1.0
	spin.allow_greater = false
	spin.allow_lesser = false
	spin.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	parent.add_child(spin)
	return spin


func _new_option_grid() -> GridContainer:
	var grid := GridContainer.new()
	grid.columns = 2
	grid.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	grid.add_theme_constant_override("h_separation", 10)
	grid.add_theme_constant_override("v_separation", 6)
	return grid


func _update_option_layout_columns() -> void:
	var columns := 1 if size.x > 0.0 and size.x < 420.0 else 2
	for grid in [_common_options, _single_options, _ui_kit_options, _atlas_options]:
		if grid != null:
			grid.columns = columns


func _configure_task_tab_theme() -> void:
	_task_tabs.add_theme_stylebox_override("panel", _task_tab_panel_style())
	var tab_bar := _task_tabs.get_tab_bar()
	tab_bar.add_theme_constant_override("h_separation", 4)
	tab_bar.add_theme_stylebox_override(
		"tab_selected",
		_task_tab_style(Color("35404d"), Color("62a9e8"), 3)
	)
	tab_bar.add_theme_stylebox_override(
		"tab_unselected",
		_task_tab_style(Color("171a1f"), Color("303740"), 1)
	)
	tab_bar.add_theme_stylebox_override(
		"tab_hovered",
		_task_tab_style(Color("29313a"), Color("4c5966"), 1)
	)
	tab_bar.add_theme_stylebox_override(
		"tab_disabled",
		_task_tab_style(Color("15171b"), Color("292e35"), 1)
	)
	tab_bar.add_theme_color_override("font_selected_color", Color("f4f7fa"))
	tab_bar.add_theme_color_override("font_unselected_color", Color("9aa4af"))
	tab_bar.add_theme_color_override("font_hovered_color", Color("dce3ea"))
	tab_bar.add_theme_color_override("font_disabled_color", Color("626b75"))


func _task_tab_style(background: Color, border: Color, bottom_width: int) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = background
	style.border_color = border
	style.border_width_left = 1
	style.border_width_top = 1
	style.border_width_right = 1
	style.border_width_bottom = bottom_width
	style.corner_radius_top_left = 5
	style.corner_radius_top_right = 5
	style.content_margin_left = 12
	style.content_margin_top = 7
	style.content_margin_right = 12
	style.content_margin_bottom = 7
	return style


func _task_tab_panel_style() -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = Color("20242a")
	style.border_color = Color("3a424c")
	style.border_width_left = 1
	style.border_width_top = 1
	style.border_width_right = 1
	style.border_width_bottom = 1
	style.corner_radius_bottom_left = 5
	style.corner_radius_bottom_right = 5
	return style


func _add_option(parent: GridContainer, label_text: String) -> OptionButton:
	var label := Label.new()
	label.text = _t(label_text)
	parent.add_child(label)
	var option := OptionButton.new()
	option.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	option.fit_to_longest_item = false
	option.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	parent.add_child(option)
	return option


func _add_check(parent: GridContainer, label_text: String, check_text: String) -> CheckButton:
	var label := Label.new()
	label.text = _t(label_text)
	parent.add_child(label)
	var check := CheckButton.new()
	check.text = _t(check_text)
	parent.add_child(check)
	return check


func _add_custom_size_controls(parent: GridContainer) -> void:
	var label := Label.new()
	label.text = _t("Output size")
	parent.add_child(label)
	_custom_size_row = HBoxContainer.new()
	_custom_size_row.visible = false
	_custom_size_row.add_theme_constant_override("separation", 4)
	parent.add_child(_custom_size_row)
	_custom_width = _size_spin_box("Width")
	_custom_size_row.add_child(_custom_width)
	var separator := Label.new()
	separator.text = "x"
	separator.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_custom_size_row.add_child(separator)
	_custom_height = _size_spin_box("Height")
	_custom_size_row.add_child(_custom_height)


func _size_spin_box(tooltip: String) -> SpinBox:
	var spin := SpinBox.new()
	spin.min_value = MIN_OUTPUT_SIZE
	spin.max_value = MAX_OUTPUT_SIZE
	spin.step = 1.0
	spin.value = 512.0
	spin.suffix = " px"
	spin.allow_greater = false
	spin.allow_lesser = false
	spin.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	spin.tooltip_text = _t(tooltip)
	return spin


func _populate_defaults() -> void:
	_generation_models.assign([DEFAULT_MODEL])
	_edit_models.clear()
	_default_image_model = DEFAULT_MODEL
	_refresh_model_options()
	_replace_size_options(DEFAULT_SIZES, str(DEFAULT_SIZES[0]))
	_replace_options(_quality, DEFAULT_QUALITIES, str(DEFAULT_QUALITIES[0]))
	_replace_options(_background, DEFAULT_BACKGROUNDS, "transparent")
	_replace_options(_format, DEFAULT_FORMATS, str(DEFAULT_FORMATS[0]), true)
	if _task_tabs != null:
		_on_task_mode_selected(_task_tabs.current_tab)


func _connect_runtime_signals() -> void:
	if godetx_dock == null:
		return
	var capabilities_callable := Callable(self, "_on_capabilities_received")
	var completed_callable := Callable(self, "_on_generation_completed")
	var failed_callable := Callable(self, "_on_generation_failed")
	var progress_callable := Callable(self, "_on_workflow_progress")
	var ui_kit_callable := Callable(self, "_on_ui_kit_completed")
	if not godetx_dock.is_connected("image_capabilities_received", capabilities_callable):
		godetx_dock.connect("image_capabilities_received", capabilities_callable)
	if not godetx_dock.is_connected("image_generation_completed", completed_callable):
		godetx_dock.connect("image_generation_completed", completed_callable)
	if not godetx_dock.is_connected("image_generation_failed", failed_callable):
		godetx_dock.connect("image_generation_failed", failed_callable)
	if not godetx_dock.is_connected("image_workflow_progress", progress_callable):
		godetx_dock.connect("image_workflow_progress", progress_callable)
	if not godetx_dock.is_connected("ui_kit_completed", ui_kit_callable):
		godetx_dock.connect("ui_kit_completed", ui_kit_callable)


func _disconnect_runtime_signals() -> void:
	if godetx_dock == null or not is_instance_valid(godetx_dock):
		return
	var connections := {
		"image_capabilities_received": Callable(self, "_on_capabilities_received"),
		"image_generation_completed": Callable(self, "_on_generation_completed"),
		"image_generation_failed": Callable(self, "_on_generation_failed"),
		"image_workflow_progress": Callable(self, "_on_workflow_progress"),
		"ui_kit_completed": Callable(self, "_on_ui_kit_completed"),
	}
	for signal_name: String in connections:
		var callback: Callable = connections[signal_name]
		if godetx_dock.is_connected(signal_name, callback):
			godetx_dock.disconnect(signal_name, callback)


func _update_runtime_state() -> void:
	if godetx_dock == null or not is_instance_valid(godetx_dock):
		_set_status("Image runtime is unavailable", Color("d87979"))
		_update_controls(false)
		return
	var state_value: Variant = godetx_dock.call("imagex_state")
	if not state_value is Dictionary:
		_set_status("Image runtime is unavailable", Color("d87979"))
		_update_controls(false)
		return
	var state: Dictionary = state_value
	_provider.text = str(state.get("provider_name", state.get("provider_id", "")))
	_planner_model = str(state.get("planner_model", ""))
	_provider.tooltip_text = _t("Planner model: %s") % _planner_model
	var fingerprint: String = str(state.get("fingerprint", ""))
	if fingerprint != _last_fingerprint:
		_last_fingerprint = fingerprint
		_transient_status_until_ms = 0
		_clear_result_status()
		_capabilities_requested = false
		_capabilities_received = false
		_image_supported = false
		_image_edit_supported = false
		_image_edit_unavailable_message = "Provider does not support image editing"
		_populate_defaults()
	var ready: bool = bool(state.get("ready", false))
	if ready and not _capabilities_requested:
		var request_value: Variant = godetx_dock.call("request_image_capabilities")
		if request_value is Dictionary and bool((request_value as Dictionary).get("ok", false)):
			_capabilities_requested = true
	if not _active_generation_id.is_empty():
		var active_status: String
		match _active_task_mode:
			TASK_UI_KIT:
				active_status = "Generating UI kit"
			TASK_RESKIN:
				active_status = "Reskinning sprite"
			TASK_ATLAS_VARIATION:
				active_status = "Creating atlas variation"
			_:
				active_status = "Generating image"
		if _cancelling:
			active_status = "Cancelling image generation"
		_set_status(active_status, Color("d5a15d") if _cancelling else Color("62a9e8"))
	elif Time.get_ticks_msec() < _transient_status_until_ms and ready:
		pass
	elif not bool(state.get("settings_complete", false)):
		_set_status("Configure an image provider", Color("d5a15d"))
	elif not ready:
		_set_status("Waiting for runtime", Color("d5a15d"))
	elif not _capabilities_received:
		_set_status("Checking image capabilities", Color("d5a15d"))
	elif not _image_supported:
		_set_status("Provider does not support image generation", Color("d87979"))
	else:
		_apply_idle_status()
	_update_controls(ready and _capabilities_received and _image_supported)


func _on_capabilities_received(capabilities: Dictionary) -> void:
	_capabilities_received = true
	_image_supported = bool(capabilities.get("supported", false))
	_image_edit_supported = false
	_edit_models.clear()
	if not _image_supported:
		if capabilities.has("error"):
			_set_status(str(capabilities.get("error", "")), Color("d87979"), true, true)
		_update_controls(false)
		return
	_max_prompt_characters = clampi(int(capabilities.get("max_prompt_characters", 32_000)), 1, 100_000)
	_default_image_model = str(capabilities.get("default_model", DEFAULT_MODEL)).strip_edges()
	if _default_image_model.is_empty():
		_default_image_model = DEFAULT_MODEL
	_generation_models = _normalized_option_values(capabilities.get("models", [DEFAULT_MODEL]))
	if _generation_models.is_empty():
		_generation_models.append(_default_image_model)
	var provider_supports_edits := bool(capabilities.get("edit_supported", false))
	if provider_supports_edits:
		if capabilities.has("edit_models"):
			_edit_models = _normalized_option_values(capabilities.get("edit_models", []))
		else:
			_edit_models.assign(_generation_models)
	_image_edit_supported = not _edit_models.is_empty()
	_image_edit_unavailable_message = (
		"Provider has no edit-capable image models"
		if provider_supports_edits and not _image_edit_supported
		else "Provider does not support image editing"
	)
	_refresh_model_options()
	_replace_size_options_from_value(capabilities.get("sizes", DEFAULT_SIZES), "1024x1024")
	_replace_options_from_value(_quality, capabilities.get("qualities", DEFAULT_QUALITIES), "auto")
	_replace_options_from_value(
		_background,
		capabilities.get("backgrounds", DEFAULT_BACKGROUNDS),
		"transparent"
	)
	_replace_options_from_value(_format, capabilities.get("output_formats", DEFAULT_FORMATS), "png", true)
	if not _image_edit_supported and _is_image_edit_mode():
		_task_tabs.current_tab = 1
		_set_status(_image_edit_unavailable_message, Color("d87979"), false, true)
	_on_task_mode_selected(_task_tabs.current_tab)
	_update_controls(true)


func _replace_options_from_value(
	option: OptionButton,
	values_value: Variant,
	preferred: String,
	uppercase_labels: bool = false
) -> void:
	var values := _normalized_option_values(values_value)
	if values.is_empty():
		values.append(preferred)
	_replace_options(option, values, preferred, uppercase_labels)


func _normalized_option_values(values_value: Variant) -> Array[String]:
	var values: Array[String] = []
	if values_value is Array:
		for value: Variant in values_value:
			var clean := str(value).strip_edges()
			if not clean.is_empty() and not values.has(clean):
				values.append(clean)
	return values


func _refresh_model_options() -> void:
	if _model == null:
		return
	var models: Array[String] = _generation_models
	if _is_image_edit_mode():
		models = _edit_models
	_replace_options(_model, models, _default_image_model)


func _replace_size_options_from_value(values_value: Variant, preferred: String) -> void:
	var values: Array[String] = []
	if values_value is Array:
		for value: Variant in values_value:
			var clean := str(value).strip_edges()
			if bool(_parse_size(clean).get("ok", false)) and not values.has(clean):
				values.append(clean)
	if values.is_empty():
		for fallback_size: Variant in DEFAULT_SIZES:
			values.append(str(fallback_size))
	_replace_size_options(values, preferred)


func _replace_size_options(values: Array, preferred: String) -> void:
	_model_source_sizes.clear()
	var display_values: Array[String] = []
	for value: Variant in values:
		var clean := str(value)
		if bool(_parse_size(clean).get("ok", false)) and not _model_source_sizes.has(clean):
			_model_source_sizes.append(clean)
			display_values.append(clean)
	if _model_source_sizes.is_empty():
		for fallback_size: Variant in DEFAULT_SIZES:
			_model_source_sizes.append(str(fallback_size))
			display_values.append(str(fallback_size))
	display_values.append(CUSTOM_SIZE)
	_replace_options(_size, display_values, preferred)
	_on_size_selected(_size.selected)


func _replace_options(
	option: OptionButton,
	values: Array,
	preferred: String,
	uppercase_labels: bool = false
) -> void:
	var previous := _selected_option(option)
	var desired := previous
	if not values.has(desired):
		desired = preferred if values.has(preferred) else (str(values[0]) if not values.is_empty() else "")
	option.clear()
	var selected_index := 0
	for value: Variant in values:
		var clean := str(value)
		var display := clean.to_upper() if uppercase_labels else _t(clean)
		if option == _background and clean == "transparent":
			display = _t("Transparent (automatic cutout)")
		elif option == _size and clean == CUSTOM_SIZE:
			display = _t("Custom")
		option.add_item(display)
		var index := option.item_count - 1
		option.set_item_metadata(index, clean)
		if clean == desired:
			selected_index = index
	if option.item_count > 0:
		option.select(selected_index)


func _selected_option(option: OptionButton) -> String:
	if option == null or option.item_count == 0 or option.selected < 0:
		return ""
	var metadata: Variant = option.get_item_metadata(option.selected)
	return str(metadata) if metadata != null else option.get_item_text(option.selected)


func _selected_task_mode() -> String:
	if _task_tabs == null or _task_tabs.get_tab_count() == 0:
		return TASK_UI_KIT
	var page := _task_tabs.get_tab_control(_task_tabs.current_tab)
	return str(page.get_meta("task_mode", TASK_UI_KIT)) if page != null else TASK_UI_KIT


func _active_prompt() -> TextEdit:
	match _selected_task_mode():
		TASK_UI_KIT:
			return _ui_kit_prompt
		TASK_RESKIN:
			return _reskin_prompt
		TASK_ATLAS_VARIATION:
			return _atlas_prompt
		_:
			return _single_prompt


func _is_image_edit_mode(task_mode: String = "") -> bool:
	var mode := task_mode if not task_mode.is_empty() else _selected_task_mode()
	return mode == TASK_RESKIN or mode == TASK_ATLAS_VARIATION


func _on_size_selected(_index: int) -> void:
	if _custom_size_row == null:
		return
	var custom: bool = _selected_option(_size) == CUSTOM_SIZE and not _is_image_edit_mode()
	_custom_size_row.visible = custom
	if custom:
		_select_option_value(_format, "png")
	else:
		var parsed: Dictionary = _parse_size(_selected_option(_size))
		if bool(parsed.get("ok", false)):
			_custom_width.value = float(parsed.get("width", 1024))
			_custom_height.value = float(parsed.get("height", 1024))
	_update_controls(_image_supported and _capabilities_received)


func _parse_size(value: String) -> Dictionary:
	var parts := value.to_lower().split("x", false, 2)
	if parts.size() != 2 or not parts[0].is_valid_int() or not parts[1].is_valid_int():
		return {"ok": false}
	var width := int(parts[0])
	var height := int(parts[1])
	if width <= 0 or height <= 0:
		return {"ok": false}
	return {"ok": true, "width": width, "height": height}


func _selected_size_request() -> Dictionary:
	var selected := _selected_option(_size)
	if selected != CUSTOM_SIZE:
		return {"ok": true, "size": selected}
	var target_width := clampi(int(round(_custom_width.value)), MIN_OUTPUT_SIZE, MAX_OUTPUT_SIZE)
	var target_height := clampi(int(round(_custom_height.value)), MIN_OUTPUT_SIZE, MAX_OUTPUT_SIZE)
	return {
		"ok": true,
		"size": _generation_size_for_target(target_width, target_height),
		"target_width": target_width,
		"target_height": target_height,
	}


func _generation_size_for_target(width: int, height: int) -> String:
	if _selected_option(_model).to_lower().begins_with("gpt-image-2"):
		var flexible_size := _gpt_image_source_size(width, height)
		if not flexible_size.is_empty():
			return flexible_size
	var target_ratio: float = float(width) / float(height)
	var best_size := str(_model_source_sizes[0]) if not _model_source_sizes.is_empty() else "1024x1024"
	var best_score: float = INF
	for candidate: String in _model_source_sizes:
		var parsed: Dictionary = _parse_size(candidate)
		if not bool(parsed.get("ok", false)):
			continue
		var candidate_ratio: float = float(parsed.get("width", 1024)) / float(parsed.get("height", 1024))
		var score: float = absf(log(candidate_ratio / target_ratio))
		if score < best_score:
			best_score = score
			best_size = candidate
	return best_size


func _gpt_image_source_size(width: int, height: int) -> String:
	var shortest: int = mini(width, height)
	var longest: int = maxi(width, height)
	if shortest <= 0 or float(longest) / float(shortest) > 3.0:
		return ""
	var scale: float = maxf(1.0, 1024.0 / float(shortest))
	var source_width: int = ceili(float(width) * scale / 16.0) * 16
	var source_height: int = ceili(float(height) * scale / 16.0) * 16
	if _is_native_flexible_size(source_width, source_height):
		return "%dx%d" % [source_width, source_height]
	return ""


func _is_native_flexible_size(width: int, height: int) -> bool:
	var shortest := mini(width, height)
	var longest := maxi(width, height)
	var pixels := width * height
	return (
		width >= 1024
		and height >= 1024
		and width % 16 == 0
		and height % 16 == 0
		and float(longest) / float(shortest) <= 3.0
		and pixels >= 655_360
		and pixels <= 8_294_400
	)


func _select_option_value(option: OptionButton, value: String) -> bool:
	if option == null:
		return false
	for option_index: int in range(option.item_count):
		if str(option.get_item_metadata(option_index)) == value:
			option.select(option_index)
			return true
	return false


func _open_source_file_dialog(task_mode: String) -> void:
	if (
		_source_file_dialog == null
		or not _active_generation_id.is_empty()
		or not _is_image_edit_mode(task_mode)
	):
		return
	_source_dialog_task_mode = task_mode
	_source_file_dialog.title = _t(
		"Select source sprite" if task_mode == TASK_RESKIN else "Select source atlas"
	)
	_source_file_dialog.popup_centered_ratio(0.72)


func _on_source_file_selected(path: String) -> void:
	var task_mode := _source_dialog_task_mode
	_source_dialog_task_mode = ""
	if not _is_image_edit_mode(task_mode):
		return
	_import_source_resource(task_mode, path, false)


func _on_source_paths_dropped(paths: PackedStringArray, task_mode: String) -> void:
	if not _is_image_edit_mode(task_mode):
		return
	if paths.size() != 1:
		_set_status("Drop exactly one project image", Color("d87979"), false, true)
		return
	_import_source_resource(task_mode, paths[0], true)


func _import_source_resource(task_mode: String, path: String, dropped: bool) -> void:
	var resource_path := path.strip_edges().replace("\\", "/")
	if not resource_path.begins_with("res://") or not ResourceLoader.exists(resource_path):
		_set_status("Select a project image from res://", Color("d87979"), false, true)
		return
	var resource: Resource = ResourceLoader.load(resource_path)
	if resource == null or not (resource is Texture2D):
		_set_status(
			"Dropped resource is not a Texture2D image"
			if dropped
			else "Selected resource is not an image",
			Color("d87979"),
			false,
			true
		)
		return
	var texture := resource as Texture2D
	var original_size := Vector2i(texture.get_width(), texture.get_height())
	var size_result := _validate_source_size(original_size)
	if not bool(size_result.get("ok", false)):
		_set_status(str(size_result.get("error", "")), Color("d87979"), true, true)
		return
	if (
		godetx_dock == null
		or not is_instance_valid(godetx_dock)
		or not godetx_dock.has_method("import_imagex_project_resource")
	):
		_set_status("Image runtime is unavailable", Color("d87979"), false, true)
		return
	_source_import_token += 1
	var token := _source_import_token
	_set_status("Importing source image", Color("62a9e8"), false, true)
	godetx_dock.call(
		"import_imagex_project_resource",
		resource_path,
		Callable(self, "_on_source_image_imported").bind(
			task_mode,
			resource_path,
			original_size,
			token
		)
	)


func _on_source_image_imported(
	result: Dictionary,
	task_mode: String,
	resource_path: String,
	original_size: Vector2i,
	token: int
) -> void:
	if _shutting_down or token != _source_import_token:
		return
	if not bool(result.get("ok", false)):
		_set_status(
			str(result.get("error", _t("Source image could not be imported"))),
			Color("d87979"),
			true,
			true
		)
		return
	var attachment_value: Variant = result.get("attachment")
	if not attachment_value is Dictionary:
		_set_status("Source image could not be imported", Color("d87979"), false, true)
		return
	var validation := _validate_imported_source(attachment_value as Dictionary, original_size)
	if not bool(validation.get("ok", false)):
		_set_status(str(validation.get("error", "")), Color("d87979"), true, true)
		return
	var attachment: Dictionary = validation.get("attachment", {})
	var preview_value: Variant = godetx_dock.call("load_imagex_attachment_preview", attachment)
	if not preview_value is Texture2D:
		_set_status("Source image preview is unavailable", Color("d87979"), false, true)
		return
	_set_source_attachment(task_mode, attachment, resource_path, preview_value as Texture2D)
	_set_status("Source image ready", Color("72c98a"), false, true)


func _validate_source_size(source_size: Vector2i) -> Dictionary:
	if (
		source_size.x < MIN_SPRITE_SOURCE_SIZE
		or source_size.y < MIN_SPRITE_SOURCE_SIZE
		or source_size.x > MAX_SPRITE_SOURCE_SIZE
		or source_size.y > MAX_SPRITE_SOURCE_SIZE
	):
		return {
			"ok": false,
			"error": _t("Source image dimensions must be between %d and %d pixels") % [
				MIN_SPRITE_SOURCE_SIZE,
				MAX_SPRITE_SOURCE_SIZE,
			],
		}
	return {"ok": true}


func _validate_imported_source(attachment: Dictionary, original_size: Vector2i) -> Dictionary:
	var size_result := _validate_source_size(original_size)
	if not bool(size_result.get("ok", false)):
		return size_result
	var attachment_id := str(attachment.get("attachment_id", ""))
	if not AttachmentStore.is_safe_attachment_id(attachment_id):
		return {"ok": false, "error": _t("Source image could not be imported")}
	var imported_size := Vector2i(
		int(attachment.get("width", 0)),
		int(attachment.get("height", 0))
	)
	if imported_size != original_size:
		return {"ok": false, "error": _t("Source image dimensions changed during import")}
	return {
		"ok": true,
		"attachment": AttachmentStore.metadata_reference(attachment),
	}


func _set_source_attachment(
	task_mode: String,
	attachment: Dictionary,
	resource_path: String,
	preview: Texture2D
) -> void:
	var dimensions := "%d x %d" % [
		int(attachment.get("width", 0)),
		int(attachment.get("height", 0)),
	]
	var display := "%s | %s" % [resource_path, dimensions]
	if task_mode == TASK_RESKIN:
		_reskin_source_attachment = attachment.duplicate(true)
		_reskin_source_preview.texture = preview
		_reskin_source_placeholder.visible = false
		_reskin_source_label.text = display
		_reskin_source_label.tooltip_text = display
	else:
		_atlas_source_attachment = attachment.duplicate(true)
		_atlas_source_preview.texture = preview
		_atlas_source_placeholder.visible = false
		_atlas_source_label.text = display
		_atlas_source_label.tooltip_text = display
		_update_atlas_frame_summary()
	_update_controls(_image_supported and _capabilities_received)


func _source_attachment_for_mode(task_mode: String) -> Dictionary:
	if task_mode == TASK_RESKIN:
		return _reskin_source_attachment
	if task_mode == TASK_ATLAS_VARIATION:
		return _atlas_source_attachment
	return {}


func _validate_image_edit_source(task_mode: String) -> Dictionary:
	var attachment := _source_attachment_for_mode(task_mode)
	if attachment.is_empty():
		return {"ok": false, "error": _t("Select source image")}
	var attachment_id := str(attachment.get("attachment_id", ""))
	var source_size := Vector2i(
		int(attachment.get("width", 0)),
		int(attachment.get("height", 0))
	)
	var size_result := _validate_source_size(source_size)
	if not AttachmentStore.is_safe_attachment_id(attachment_id):
		return {"ok": false, "error": _t("Source image is invalid")}
	if not bool(size_result.get("ok", false)):
		return size_result
	var result := {
		"ok": true,
		"attachment_id": attachment_id,
		"width": source_size.x,
		"height": source_size.y,
	}
	if task_mode != TASK_ATLAS_VARIATION:
		return result
	var columns := int(round(_atlas_columns.value))
	var rows := int(round(_atlas_rows.value))
	var frame_count := columns * rows
	if columns < 1 or rows < 1 or frame_count > MAX_ATLAS_FRAMES:
		return {
			"ok": false,
			"error": _t("Atlas frame count must not exceed %d") % MAX_ATLAS_FRAMES,
		}
	if source_size.x % columns != 0 or source_size.y % rows != 0:
		return {
			"ok": false,
			"error": _t("Atlas columns and rows must divide the source dimensions evenly"),
		}
	result["columns"] = columns
	result["rows"] = rows
	result["frame_width"] = source_size.x / columns
	result["frame_height"] = source_size.y / rows
	result["frame_count"] = frame_count
	return result


func _on_atlas_grid_changed(_value: float) -> void:
	_update_atlas_frame_summary()
	_update_controls(_image_supported and _capabilities_received)


func _update_atlas_frame_summary() -> void:
	if _atlas_frame_summary == null:
		return
	if _atlas_source_attachment.is_empty():
		_atlas_frame_summary.text = ""
		return
	var validation := _validate_image_edit_source(TASK_ATLAS_VARIATION)
	if not bool(validation.get("ok", false)):
		_atlas_frame_summary.text = str(validation.get("error", ""))
		_atlas_frame_summary.add_theme_color_override("font_color", Color("d87979"))
		return
	_atlas_frame_summary.text = _t("Frame size: %d x %d, %d frames") % [
		int(validation.get("frame_width", 0)),
		int(validation.get("frame_height", 0)),
		int(validation.get("frame_count", 0)),
	]
	_atlas_frame_summary.add_theme_color_override("font_color", Color("8f98a3"))


func _on_task_mode_selected(_index: int) -> void:
	if _task_tabs == null:
		return
	var task_mode := _selected_task_mode()
	_refresh_model_options()
	var ui_kit_mode: bool = task_mode == TASK_UI_KIT
	match task_mode:
		TASK_UI_KIT:
			_generate_button.text = _t("Generate UI kit")
		TASK_RESKIN:
			_generate_button.text = _t("Reskin sprite")
		TASK_ATLAS_VARIATION:
			_generate_button.text = _t("Create atlas variation")
		_:
			_generate_button.text = _t("Generate")
	if _is_image_edit_mode(task_mode):
		_select_option_value(_background, "transparent")
		_select_option_value(_format, "png")
	_asset_result_select.visible = ui_kit_mode and not _ui_kit_assets.is_empty()
	_on_size_selected(_size.selected)
	_update_controls(_image_supported and _capabilities_received)


func _on_background_selected(_index: int) -> void:
	if _selected_option(_background) == "transparent":
		_select_option_value(_format, "png")
	_update_controls(_image_supported and _capabilities_received)


func _on_format_selected(_index: int) -> void:
	if _selected_option(_background) == "transparent" and _selected_option(_format) != "png":
		_select_option_value(_format, "png")


func _generate() -> void:
	if not _active_generation_id.is_empty():
		return
	var task_mode: String = _selected_task_mode()
	var prompt := _active_prompt()
	var prompt_text := prompt.text.strip_edges() if prompt != null else ""
	if prompt_text.is_empty():
		_set_status("Enter an image prompt", Color("d87979"), false, true)
		return
	var maximum_prompt_characters := (
		mini(_max_prompt_characters, MAX_IMAGE_EDIT_PROMPT_CHARACTERS)
		if _is_image_edit_mode(task_mode)
		else _max_prompt_characters
	)
	if prompt_text.length() > maximum_prompt_characters:
		_set_status("Image prompt is too long", Color("d87979"), false, true)
		return
	if _is_image_edit_mode(task_mode) and not _image_edit_supported:
		_set_status(_image_edit_unavailable_message, Color("d87979"), false, true)
		return
	var edit_source: Dictionary = {}
	var size_request: Dictionary
	if _is_image_edit_mode(task_mode):
		edit_source = _validate_image_edit_source(task_mode)
		if not bool(edit_source.get("ok", false)):
			_set_status(str(edit_source.get("error", "")), Color("d87979"), true, true)
			return
		size_request = {
			"ok": true,
			"size": _generation_size_for_target(
				int(edit_source.get("width", 0)),
				int(edit_source.get("height", 0))
			),
		}
	else:
		size_request = _selected_size_request()
	if not bool(size_request.get("ok", false)):
		_set_status("Custom output size is invalid", Color("d87979"), false, true)
		return
	if (
		task_mode == TASK_SINGLE
		and (_selected_option(_background) == "transparent" or size_request.has("target_width"))
	):
		_select_option_value(_format, "png")
	if task_mode == TASK_UI_KIT and _planner_model.is_empty():
		_set_status("Planner model is unavailable", Color("d87979"), false, true)
		return
	_active_generation_id = Crypto.new().generate_random_bytes(16).hex_encode()
	_active_task_mode = task_mode
	_cancelling = false
	_transient_status_until_ms = 0
	_clear_result_status()
	_workflow_plan_text = ""
	_workflow_details.text = ""
	_workflow_details.visible = task_mode == TASK_UI_KIT
	_ui_kit_assets.clear()
	_asset_result_select.clear()
	_asset_result_select.visible = false
	var request_value: Variant
	if task_mode == TASK_UI_KIT:
		var ui_kit_params: Dictionary = {
			"workflow_id": _active_generation_id,
			"prompt": prompt_text,
			"planner_model": _planner_model,
			"image_model": _selected_option(_model),
			"size": str(size_request.get("size", "1024x1024")),
			"quality": _selected_option(_quality),
			"background": _selected_option(_background),
			"output_format": "png",
			"max_assets": int(_selected_option(_asset_count)),
			"review_enabled": _vision_review.button_pressed,
			"capture_viewport": _capture_viewport.button_pressed,
		}
		if size_request.has("target_width"):
			ui_kit_params["target_width"] = int(size_request.get("target_width", 0))
			ui_kit_params["target_height"] = int(size_request.get("target_height", 0))
		request_value = godetx_dock.call("request_ui_kit_generation", ui_kit_params)
	elif _is_image_edit_mode(task_mode):
		var edit_params: Dictionary = {
			"generation_id": _active_generation_id,
			"mode": task_mode,
			"prompt": prompt_text,
			"source_attachment_id": str(edit_source.get("attachment_id", "")),
			"model": _selected_option(_model),
			"size": str(size_request.get("size", "1024x1024")),
			"quality": _selected_option(_quality),
			"background": "transparent",
			"output_format": "png",
			"input_fidelity": "high",
		}
		if task_mode == TASK_ATLAS_VARIATION:
			edit_params["columns"] = int(edit_source.get("columns", 1))
			edit_params["rows"] = int(edit_source.get("rows", 1))
		request_value = godetx_dock.call("request_image_edit", edit_params)
	else:
		var image_params: Dictionary = {
			"generation_id": _active_generation_id,
			"prompt": prompt_text,
			"model": _selected_option(_model),
			"size": str(size_request.get("size", "1024x1024")),
			"quality": _selected_option(_quality),
			"background": _selected_option(_background),
			"output_format": _selected_option(_format),
		}
		if size_request.has("target_width"):
			image_params["target_width"] = int(size_request.get("target_width", 0))
			image_params["target_height"] = int(size_request.get("target_height", 0))
		request_value = godetx_dock.call("request_image_generation", image_params)
	if not request_value is Dictionary or not bool((request_value as Dictionary).get("ok", false)):
		var error_message := _t("Image generation could not be started")
		if request_value is Dictionary:
			error_message = str((request_value as Dictionary).get("error", error_message))
		_active_generation_id = ""
		_active_task_mode = ""
		_set_result_status(error_message, Color("d87979"), true)
	_update_controls(true)


func _cancel_generation() -> void:
	if _active_generation_id.is_empty() or godetx_dock == null:
		return
	godetx_dock.call("cancel_image_generation", _active_generation_id)
	if _active_generation_id.is_empty():
		return
	_cancelling = true
	_set_status("Cancelling image generation", Color("d5a15d"))
	_stop_button.disabled = true


func _on_generation_completed(result: Dictionary) -> void:
	var generation_id := str(result.get("generation_id", ""))
	if generation_id != _active_generation_id:
		return
	var completed_task_mode := _active_task_mode
	_active_generation_id = ""
	_active_task_mode = ""
	_cancelling = false
	_asset_result_select.visible = false
	var resource_path := str(result.get("resource_path", ""))
	if not _display_resource_path(resource_path):
		_set_result_status("Runtime returned an invalid image path", Color("d87979"))
		_update_controls(true)
		return
	_reveal_generated_result()
	if not _last_result_preview_loaded:
		_set_result_status("Image was saved but its preview could not be loaded", Color("d5a15d"))
	elif completed_task_mode == TASK_RESKIN:
		_set_result_status("Sprite reskin generated", Color("72c98a"))
	elif completed_task_mode == TASK_ATLAS_VARIATION:
		_set_result_status("Atlas variation generated", Color("72c98a"))
	elif bool(result.get("resized", false)):
		_set_result_status(
			"Image generated and resized to %dx%d" % [
				int(result.get("output_width", 0)),
				int(result.get("output_height", 0)),
			],
			Color("72c98a"),
			true
		)
	elif str(result.get("transparency_mode", "")) == "chroma_key":
		_set_result_status("Image generated with automatic green-screen cutout", Color("72c98a"))
	else:
		_set_result_status("Image generated", Color("72c98a"))
	_update_controls(true)


func _on_generation_failed(generation_id: String, message: String) -> void:
	if generation_id != _active_generation_id:
		return
	_active_generation_id = ""
	_active_task_mode = ""
	_cancelling = false
	_set_result_status(message, Color("d87979"), true)
	_update_controls(true)


func _on_workflow_progress(progress: Dictionary) -> void:
	if str(progress.get("workflow_id", "")) != _active_generation_id:
		return
	var phase: String = str(progress.get("phase", ""))
	match phase:
		"capturing":
			_set_status("Capturing Godot context", Color("62a9e8"))
			_workflow_details.text = _t("Capturing the current scene and 2D viewport")
		"planning":
			_set_status("Planning UI kit", Color("62a9e8"))
			_workflow_details.text = _t("The planner model is analyzing the Godot scene context")
		"planned":
			_workflow_plan_text = _format_ui_kit_plan(progress.get("plan", {}))
			_workflow_details.text = _workflow_plan_text
		"generating":
			var current: int = int(progress.get("current", 0))
			var total: int = int(progress.get("total", 0))
			var asset_name: String = str(progress.get("asset_name", progress.get("asset_id", "")))
			_set_status("Generating UI kit", Color("62a9e8"))
			_workflow_details.text = "%s\n%s" % [
				_workflow_plan_text,
				_t("Generating asset %d/%d: %s") % [current, total, asset_name],
			]
		"reviewing":
			_set_status("Reviewing UI kit", Color("62a9e8"))
			_workflow_details.text = "%s\n%s" % [
				_workflow_plan_text,
				_t("The planner model is visually reviewing the generated assets"),
			]


func _on_ui_kit_completed(result: Dictionary) -> void:
	if str(result.get("workflow_id", "")) != _active_generation_id:
		return
	_active_generation_id = ""
	_active_task_mode = ""
	_cancelling = false
	_ui_kit_assets.clear()
	_asset_result_select.clear()
	var used_chroma_key: bool = false
	var assets_value: Variant = result.get("assets", [])
	if assets_value is Array:
		for asset_value: Variant in assets_value:
			if not asset_value is Dictionary:
				continue
			var asset: Dictionary = (asset_value as Dictionary).duplicate(true)
			var resource_path := str(asset.get("resource_path", ""))
			if not resource_path.begins_with("res://"):
				continue
			_ui_kit_assets.append(asset)
			if str(asset.get("transparency_mode", "")) == "chroma_key":
				used_chroma_key = true
			_asset_result_select.add_item("%s - %s" % [
				str(asset.get("name", asset.get("id", "Asset"))),
				str(asset.get("role", "")),
			])
	if _ui_kit_assets.is_empty():
		_set_status("Runtime returned no UI kit assets", Color("d87979"), false, true)
		_update_controls(true)
		return
	_asset_result_select.visible = true
	_asset_result_select.select(0)
	_on_asset_result_selected(0)
	_reveal_generated_result()
	var plan_value: Variant = result.get("plan", {})
	if plan_value is Dictionary:
		_workflow_plan_text = _format_ui_kit_plan(plan_value)
	var review_value: Variant = result.get("review", {})
	var review_text: String = _format_ui_kit_review(review_value)
	var first_asset: Dictionary = _ui_kit_assets[0]
	var output_width: int = int(first_asset.get("output_width", 0))
	var output_height: int = int(first_asset.get("output_height", 0))
	if output_width > 0 and output_height > 0:
		review_text += "\n%s" % (_t("Output size: %dx%d") % [output_width, output_height])
	if used_chroma_key:
		review_text += "\n%s" % _t("Transparent background created with local green-screen cutout")
	_workflow_details.text = "%s\n%s" % [_workflow_plan_text, review_text]
	var review_passed: bool = review_value is Dictionary and bool((review_value as Dictionary).get("passed", false))
	var review_status: String = str((review_value as Dictionary).get("status", "")) if review_value is Dictionary else ""
	if not _last_result_preview_loaded:
		_set_result_status("Image was saved but its preview could not be loaded", Color("d5a15d"))
	elif review_status == "completed" and not review_passed:
		_set_result_status("UI kit generated with review issues", Color("d5a15d"))
	elif used_chroma_key:
		_set_result_status("UI kit generated with automatic green-screen cutout", Color("72c98a"))
	else:
		_set_result_status("UI kit generated", Color("72c98a"))
	_update_controls(true)


func _on_asset_result_selected(index: int) -> void:
	if index < 0 or index >= _ui_kit_assets.size():
		return
	_display_resource_path(str(_ui_kit_assets[index].get("resource_path", "")))


func _display_resource_path(resource_path: String) -> bool:
	_last_result_preview_loaded = false
	if not resource_path.begins_with("res://") or not FileAccess.file_exists(resource_path):
		return false
	_result_resource_path = resource_path
	var image := Image.new()
	var load_error := image.load(ProjectSettings.globalize_path(resource_path))
	if load_error != OK or image.is_empty():
		_set_result_status("Image was saved but its preview could not be loaded", Color("d5a15d"))
	else:
		_preview.texture = ImageTexture.create_from_image(image)
		_preview_placeholder.visible = false
		_last_result_preview_loaded = true
	_result_path.text = resource_path
	_result_path.tooltip_text = resource_path
	_locate_button.disabled = not ResourceLoader.exists(resource_path)
	if _locate_button.disabled:
		_locate_button.tooltip_text = _t("Waiting for Godot to import the generated image")
		_queue_generated_resource_import(resource_path)
	else:
		_locate_button.tooltip_text = _t("Show generated image in FileSystem")
	return true


func _reveal_generated_result() -> void:
	if _result_scroll == null:
		return
	_result_scroll.scroll_vertical = 0
	call_deferred("_ensure_generated_result_visible")


func _ensure_generated_result_visible() -> void:
	if _shutting_down or _result_scroll == null or _preview == null:
		return
	_result_scroll.scroll_vertical = 0
	if _result_scroll.is_inside_tree() and _preview.is_inside_tree():
		_result_scroll.ensure_control_visible(_preview)


func _queue_generated_resource_import(resource_path: String) -> void:
	if (
		_shutting_down
		or editor_interface == null
		or not resource_path.begins_with("res://")
		or _pending_resource_imports.has(resource_path)
	):
		return
	_pending_resource_imports[resource_path] = 0
	call_deferred("_scan_generated_resource", resource_path)


func _scan_generated_directory() -> void:
	if _shutting_down or editor_interface == null:
		return
	var filesystem: EditorFileSystem = editor_interface.get_resource_filesystem()
	if filesystem != null and not filesystem.is_scanning():
		filesystem.scan()


func _scan_generated_resource(resource_path: String) -> void:
	if _shutting_down or not _pending_resource_imports.has(resource_path):
		return
	var filesystem: EditorFileSystem = editor_interface.get_resource_filesystem()
	if filesystem == null:
		_pending_resource_imports.erase(resource_path)
		return
	if not filesystem.is_scanning():
		filesystem.scan()
	_poll_generated_resource_import(resource_path)


func _poll_generated_resource_import(resource_path: String) -> void:
	if _shutting_down or not _pending_resource_imports.has(resource_path):
		return
	if ResourceLoader.exists(resource_path):
		_pending_resource_imports.erase(resource_path)
		if resource_path == _result_resource_path:
			_locate_button.disabled = false
			_locate_button.tooltip_text = _t("Show generated image in FileSystem")
		return
	var attempt: int = int(_pending_resource_imports.get(resource_path, 0)) + 1
	if attempt >= 120:
		_pending_resource_imports.erase(resource_path)
		return
	_pending_resource_imports[resource_path] = attempt
	# A scan that was already in progress when the file was saved may not include it.
	# Retry after that scan settles instead of leaving a valid PNG permanently unimported.
	var filesystem: EditorFileSystem = editor_interface.get_resource_filesystem()
	if filesystem != null and not filesystem.is_scanning() and attempt % 8 == 1:
		filesystem.scan()
	await get_tree().create_timer(0.25).timeout
	_poll_generated_resource_import(resource_path)


func _format_ui_kit_plan(plan_value: Variant) -> String:
	if not plan_value is Dictionary:
		return ""
	var plan: Dictionary = plan_value
	var lines: PackedStringArray = PackedStringArray()
	var summary: String = str(plan.get("summary", ""))
	var style: String = str(plan.get("style", ""))
	if not summary.is_empty():
		lines.append(_t("Plan: %s") % summary)
	if not style.is_empty():
		lines.append(_t("Style: %s") % style)
	var assets_value: Variant = plan.get("assets", [])
	if assets_value is Array:
		var names: PackedStringArray = PackedStringArray()
		for asset_value: Variant in assets_value:
			if asset_value is Dictionary:
				names.append(str((asset_value as Dictionary).get("name", (asset_value as Dictionary).get("id", ""))))
		if not names.is_empty():
			lines.append(_t("Assets: %s") % ", ".join(names))
	return "\n".join(lines)


func _format_ui_kit_review(review_value: Variant) -> String:
	if not review_value is Dictionary:
		return _t("Visual review unavailable")
	var review: Dictionary = review_value
	var status: String = str(review.get("status", ""))
	if status == "skipped":
		return _t("Visual review skipped: %s") % str(review.get("summary", ""))
	if status == "failed":
		return _t("Visual review failed: %s") % str(review.get("summary", ""))
	var lines: PackedStringArray = PackedStringArray([
		_t("Visual review: %d/100 - %s") % [
			int(review.get("score", 0)),
			str(review.get("summary", "")),
		],
	])
	var issues_value: Variant = review.get("issues", [])
	if issues_value is Array:
		for issue_index: int in range(mini((issues_value as Array).size(), 3)):
			var issue_value: Variant = (issues_value as Array)[issue_index]
			if issue_value is Dictionary:
				lines.append("- %s: %s" % [
					str((issue_value as Dictionary).get("asset_id", "kit")),
					str((issue_value as Dictionary).get("message", "")),
				])
	return "\n".join(lines)


func _update_controls(provider_ready: bool) -> void:
	var generating: bool = not _active_generation_id.is_empty()
	var ui_kit_mode: bool = false
	var task_mode := TASK_UI_KIT
	if _task_tabs != null:
		task_mode = _selected_task_mode()
		ui_kit_mode = task_mode == TASK_UI_KIT
	var edit_mode := _is_image_edit_mode(task_mode)
	var edit_ready := true
	if edit_mode:
		edit_ready = _image_edit_supported and bool(
			_validate_image_edit_source(task_mode).get("ok", false)
		)
	_generate_button.disabled = generating or not provider_ready or not edit_ready
	_stop_button.disabled = not generating
	_single_prompt.editable = not generating
	_ui_kit_prompt.editable = not generating
	_reskin_prompt.editable = not generating
	_atlas_prompt.editable = not generating
	if _task_tabs != null:
		var task_bar := _task_tabs.get_tab_bar()
		for tab_index: int in range(_task_tabs.get_tab_count()):
			var page := _task_tabs.get_tab_control(tab_index)
			var tab_mode := str(page.get_meta("task_mode", "")) if page != null else ""
			var edit_tab := _is_image_edit_mode(tab_mode)
			task_bar.set_tab_disabled(
				tab_index,
				generating or not provider_ready or (edit_tab and not _image_edit_supported)
			)
			_task_tabs.set_tab_tooltip(
				tab_index,
				_t(_image_edit_unavailable_message)
				if edit_tab and provider_ready and not _image_edit_supported
				else ""
			)
	_model.disabled = generating or not provider_ready
	_size.disabled = generating or not provider_ready or edit_mode
	_quality.disabled = generating or not provider_ready
	_background.disabled = generating or not provider_ready or edit_mode
	_format.disabled = (
		generating
		or not provider_ready
		or _selected_option(_background) == "transparent"
		or _selected_option(_size) == CUSTOM_SIZE
	)
	_custom_width.get_line_edit().editable = not generating and provider_ready and not edit_mode
	_custom_height.get_line_edit().editable = not generating and provider_ready and not edit_mode
	_asset_count.disabled = generating or not provider_ready or not ui_kit_mode
	_capture_viewport.disabled = generating or not provider_ready or not ui_kit_mode
	_vision_review.disabled = generating or not provider_ready or not ui_kit_mode
	var source_selection_enabled := not generating and provider_ready and _image_edit_supported
	_reskin_source_button.disabled = not source_selection_enabled
	_atlas_source_button.disabled = not source_selection_enabled
	_reskin_source_drop_target.drop_enabled = source_selection_enabled
	_atlas_source_drop_target.drop_enabled = source_selection_enabled
	var atlas_grid_enabled := source_selection_enabled and task_mode == TASK_ATLAS_VARIATION
	_atlas_columns.editable = atlas_grid_enabled
	_atlas_rows.editable = atlas_grid_enabled


func _clear_result_status() -> void:
	_result_status_text = ""
	_result_status_color = Color("72c98a")
	_result_status_literal = false


func _apply_idle_status() -> void:
	if not _result_status_text.is_empty():
		_set_status(_result_status_text, _result_status_color, _result_status_literal)
	else:
		_set_status("Ready", Color("72c98a"))


func _set_result_status(text: String, color: Color, literal: bool = false) -> void:
	_result_status_text = text
	_result_status_color = color
	_result_status_literal = literal
	_transient_status_until_ms = 0
	_set_status(text, color, literal)


func _set_status(text: String, color: Color, literal: bool = false, transient: bool = false) -> void:
	var display := text if literal else _t(text)
	if transient:
		_transient_status_until_ms = Time.get_ticks_msec() + 5000
	if _last_status_key == display and _status.get_theme_color("font_color") == color:
		return
	_last_status_key = display
	_status.text = display
	_status.tooltip_text = display
	_status.add_theme_color_override("font_color", color)


func _open_settings() -> void:
	if godetx_dock != null:
		godetx_dock.call("open_connection_settings")


func _locate_result() -> void:
	if editor_interface == null or _result_resource_path.is_empty():
		return
	if not ResourceLoader.exists(_result_resource_path):
		_set_status("Godot is still importing the generated image", Color("d5a15d"), false, true)
		_queue_generated_resource_import(_result_resource_path)
		return
	var filesystem_dock = editor_interface.get_file_system_dock()
	if filesystem_dock != null and filesystem_dock.has_method("navigate_to_path"):
		filesystem_dock.call("navigate_to_path", _result_resource_path)


func _on_prompt_gui_input(event: InputEvent, prompt: TextEdit) -> void:
	var key_event := event as InputEventKey
	if (
		key_event != null
		and key_event.pressed
		and not key_event.echo
		and key_event.keycode == KEY_ENTER
		and not key_event.shift_pressed
	):
		prompt.accept_event()
		_generate()


func _preview_style() -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = Color("15181c")
	style.border_color = Color("343a42")
	style.border_width_left = 1
	style.border_width_top = 1
	style.border_width_right = 1
	style.border_width_bottom = 1
	style.corner_radius_top_left = 6
	style.corner_radius_top_right = 6
	style.corner_radius_bottom_left = 6
	style.corner_radius_bottom_right = 6
	style.content_margin_left = 8
	style.content_margin_top = 8
	style.content_margin_right = 8
	style.content_margin_bottom = 8
	return style


func _t(message: String) -> String:
	return Localization.translate(message)
