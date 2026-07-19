extends SceneTree

const DockContent := preload("res://addons/godetx/godetx_dock.gd")
const ImageXContent := preload("res://addons/godetx/imagex_dock.gd")
const ResourceDropTarget := preload("res://addons/godetx/resource_drop_target.gd")
const SkillXContent := preload("res://addons/godetx/skillx_dock.gd")
const Localization := preload("res://addons/godetx/localization.gd")

var _failures := PackedStringArray()


func _init() -> void:
	var project_locale_before := TranslationServer.get_locale()
	var main_probe := &"GODETX_LOCALIZATION_MAIN_DOMAIN_PROBE"
	var main_translation_before := TranslationServer.translate(main_probe)

	_assert(Localization.resolve_locale("zh_CN") == Localization.LOCALE_ZH_CN, "Simplified Chinese should select zh_CN")
	_assert(Localization.resolve_locale("zh-Hans-CN") == Localization.LOCALE_ZH_CN, "Chinese script locales should select Chinese")
	_assert(Localization.resolve_locale("en_US") == Localization.LOCALE_EN, "English should select the source locale")
	_assert(Localization.resolve_locale("ja_JP") == Localization.LOCALE_EN, "Unsupported locales should fall back to English")
	_assert(
		Localization.translate_for_locale("Authentication failed", "zh_CN") != "Authentication failed"
		and Localization.translate_for_locale("Runtime connection failed", "zh_CN") != "Runtime connection failed",
		"Authentication and Runtime startup failures should be localized"
	)
	_assert(
		Localization.translate_for_locale("Ask for approval", "zh_CN") == "请求批准"
		and Localization.translate_for_locale("Ask for approval", "en_US") == "Ask for approval",
		"Direct locale resolution should preserve the English fallback"
	)
	_assert(
		Localization.translate_for_locale(
			"Save open scripts before sending a task. The task was not sent.",
			"zh_CN"
		) == "请先保存已打开的脚本，再发送任务。任务未发送。"
		and Localization.translate_for_locale(
			"GodotX plugin files changed. Reload the plugin before sending another task.",
			"zh_CN"
		) == "GodotX 插件文件已更改。请重新加载插件后再发送任务。",
		"Script safety and plugin reload guidance should be localized"
	)

	var domain: TranslationDomain = Localization.install_for_locale("zh_CN")
	_assert(TranslationServer.has_domain(Localization.DOMAIN), "GodotX should install a dedicated translation domain")
	_assert(domain.get_locale_override() == Localization.LOCALE_ZH_CN, "The plugin domain should use its own locale override")
	_assert(
		str(domain.translate(&"Starting runtime")) == "正在启动运行时",
		"The Chinese catalog should be active in the plugin domain"
	)
	_assert(
		str(domain.translate(&"%d table rows omitted.")) == "已省略 %d 行表格内容。",
		"Markdown table truncation should use the plugin localization domain"
	)
	var imagex := ImageXContent.new()
	imagex.set_translation_domain(Localization.DOMAIN)
	imagex._build_ui()
	imagex._populate_defaults()
	_assert(
		imagex._ui_kit_prompt.placeholder_text == "描述当前场景需要的 UI 套件"
		and imagex._single_prompt.placeholder_text == "描述要生成的图片"
		and imagex._reskin_prompt.placeholder_text == "描述新的精灵外观"
		and imagex._atlas_prompt.placeholder_text == "描述新的图集变体"
		and imagex._generate_button.text == "生成 UI 套件"
		and imagex._task_tabs is TabContainer
		and imagex._task_tabs.get_tab_count() == 4
		and imagex._task_tabs.get_tab_title(0) == "AI UI 套件"
		and imagex._task_tabs.get_tab_title(1) == "单张图片"
		and imagex._task_tabs.get_tab_title(2) == "精灵换皮"
		and imagex._task_tabs.get_tab_title(3) == "图集变体"
		and imagex._selected_task_mode() == imagex.TASK_UI_KIT
		and imagex._background.get_item_text(2) == Localization.translate("Transparent (automatic cutout)")
		and imagex._size.get_item_text(imagex._size.item_count - 1) == Localization.translate("Custom")
		and imagex._model.get_parent() == imagex._common_options
		and imagex._size.get_parent() == imagex._common_options
		and imagex._quality.get_parent() == imagex._common_options
		and imagex._background.get_parent() == imagex._common_options
		and imagex._format.get_parent() == imagex._single_options
		and imagex._asset_count.get_parent() == imagex._ui_kit_options
		and imagex._capture_viewport.get_parent() == imagex._ui_kit_options
		and imagex._vision_review.get_parent() == imagex._ui_kit_options
		and imagex._workflow_details is TextEdit
		and imagex._workflow_details.custom_minimum_size.y == 120.0
		and imagex._source_file_dialog.access == FileDialog.ACCESS_RESOURCES
		and imagex._source_file_dialog.file_mode == FileDialog.FILE_MODE_OPEN_FILE
		and imagex._reskin_source_drop_target is PanelContainer
		and imagex._atlas_source_drop_target is PanelContainer
		and imagex._reskin_source_placeholder.text == "源图片预览"
		and imagex._atlas_columns.value == 4.0
		and imagex._atlas_rows.value == 4.0
		and imagex._background.disabled
		and imagex._format.disabled,
		"ImageX controls should use the plugin Chinese catalog"
	)
	var selected_tab_style := (
		imagex._task_tabs.get_tab_bar().get_theme_stylebox("tab_selected") as StyleBoxFlat
	)
	var unselected_tab_style := (
		imagex._task_tabs.get_tab_bar().get_theme_stylebox("tab_unselected") as StyleBoxFlat
	)
	_assert(
		selected_tab_style != null
		and unselected_tab_style != null
		and selected_tab_style.bg_color != unselected_tab_style.bg_color
		and selected_tab_style.border_width_bottom == 3
		and unselected_tab_style.border_width_bottom == 1,
		"ImageX task tabs should have a distinct selected visual state"
	)
	imagex._update_controls(true)
	imagex._task_tabs.current_tab = 1
	imagex._on_task_mode_selected(1)
	imagex._select_option_value(imagex._background, "opaque")
	imagex._select_option_value(imagex._format, "webp")
	_assert(
		imagex._selected_task_mode() == imagex.TASK_SINGLE
		and imagex._generate_button.text == "生成",
		"ImageX single-image tab should select its own localized task state"
	)
	imagex._task_tabs.current_tab = 0
	imagex._on_task_mode_selected(0)
	_assert(
		imagex._selected_option(imagex._background) == "opaque"
		and imagex._selected_option(imagex._format) == "webp",
		"UI kit task selection should not overwrite the shared background or single-image format"
	)
	_assert(
		imagex._gpt_image_source_size(512, 256) == "2048x1024"
		and imagex._gpt_image_source_size(1000, 1000) == "1024x1024"
		and imagex._gpt_image_source_size(512, 64).is_empty(),
		"ImageX custom sizes should choose a valid proportional GPT Image source"
	)
	imagex._on_capabilities_received({
		"supported": true,
		"edit_supported": true,
		"models": ["generation-only", "shared-model"],
		"edit_models": ["shared-model"],
		"default_model": "shared-model",
	})
	_assert(
		imagex._generation_models == ["generation-only", "shared-model"]
		and imagex._edit_models == ["shared-model"]
		and imagex._model.item_count == 2,
		"ImageX should retain the full generation model list separately from edit models"
	)
	imagex._select_option_value(imagex._model, "generation-only")
	imagex._task_tabs.current_tab = 2
	imagex._on_task_mode_selected(2)
	_assert(
		imagex._selected_task_mode() == imagex.TASK_RESKIN
		and imagex._active_prompt() == imagex._reskin_prompt
		and imagex._model.item_count == 1
		and imagex._selected_option(imagex._model) == "shared-model"
		and imagex._generate_button.text == "生成换皮精灵"
		and imagex._selected_option(imagex._background) == "transparent"
		and imagex._background.disabled
		and imagex._size.disabled
		and imagex._generate_button.disabled,
		"ImageX reskin mode should require a source and force transparent output"
	)
	var source_attachment := {
		"attachment_id": "a".repeat(64),
		"mime_type": "image/png",
		"width": 128,
		"height": 64,
		"size_bytes": 1024,
		"source": "project_resource",
	}
	_assert(
		bool(imagex._validate_imported_source(source_attachment, Vector2i(128, 64)).get("ok", false))
		and not bool(imagex._validate_imported_source(
			source_attachment,
			Vector2i(64, 64)
		).get("ok", true))
		and not bool(imagex._validate_source_size(Vector2i(8, 8)).get("ok", true)),
		"ImageX source imports should reject resized and out-of-range textures"
	)
	var packed_drop_paths := ResourceDropTarget.paths_from_drop_data({
		"type": "files",
		"files": PackedStringArray([
			"res://addons/godetx/imagex_dock.gd",
			"res://addons/godetx/imagex_dock.gd",
		]),
	})
	var array_drop_paths := ResourceDropTarget.paths_from_drop_data({
		"type": "files",
		"files": [
			"res://addons/godetx/imagex_dock.gd",
			"res://addons/godetx/localization.gd",
		],
	})
	_assert(
		packed_drop_paths == PackedStringArray(["res://addons/godetx/imagex_dock.gd"])
		and array_drop_paths.size() == 2
		and ResourceDropTarget.paths_from_drop_data({
			"type": "files",
			"files": PackedStringArray(["res://addons/godetx/../godetx/imagex_dock.gd"]),
		}).is_empty()
		and ResourceDropTarget.paths_from_drop_data({
			"type": "files",
			"files": PackedStringArray([
				"res://addons/godetx/imagex_dock.gd",
				"res://addons/godetx/../godetx/localization.gd",
			]),
		}).is_empty()
		and ResourceDropTarget.paths_from_drop_data({
			"type": "files",
			"files": PackedStringArray(["res://addons/godetx"]),
		}).is_empty()
		and ResourceDropTarget.paths_from_drop_data({
			"type": "resource",
			"files": PackedStringArray(["res://addons/godetx/imagex_dock.gd"]),
		}).is_empty(),
		"Project resource drops should normalize safe files and reject invalid payloads"
	)
	imagex._on_source_paths_dropped(array_drop_paths, imagex.TASK_RESKIN)
	_assert(
		imagex._status.text == "请只拖放一张项目图片",
		"ImageX should explain that sprite source drops accept exactly one file"
	)
	imagex._import_source_resource(
		imagex.TASK_RESKIN,
		"res://addons/godetx/localization.gd",
		true
	)
	_assert(
		imagex._status.text == "拖入的资源不是 Texture2D 图片",
		"ImageX should explain that a dropped resource is not a texture"
	)
	imagex._reskin_source_attachment = source_attachment.duplicate(true)
	_assert(
		bool(imagex._validate_image_edit_source(imagex.TASK_RESKIN).get("ok", false)),
		"ImageX reskin validation should accept a safe imported attachment"
	)
	imagex._atlas_source_attachment = source_attachment.duplicate(true)
	imagex._atlas_columns.value = 4.0
	imagex._atlas_rows.value = 2.0
	var atlas_validation: Dictionary = imagex._validate_image_edit_source(
		imagex.TASK_ATLAS_VARIATION
	)
	_assert(
		bool(atlas_validation.get("ok", false))
		and atlas_validation.get("frame_width") == 32
		and atlas_validation.get("frame_height") == 32
		and atlas_validation.get("frame_count") == 8,
		"ImageX atlas validation should derive an exact row-column grid"
	)
	imagex._atlas_columns.value = 3.0
	_assert(
		not bool(imagex._validate_image_edit_source(
			imagex.TASK_ATLAS_VARIATION
		).get("ok", true)),
		"ImageX atlas validation should reject grids that do not divide the source"
	)
	imagex._on_capabilities_received({
		"supported": true,
		"edit_supported": true,
		"models": ["generation-only"],
		"edit_models": [],
		"default_model": "generation-only",
	})
	_assert(
		not imagex._image_edit_supported
		and imagex._task_tabs.current_tab == 1
		and imagex._task_tabs.get_tab_bar().is_tab_disabled(2),
		"ImageX should disable sprite tasks when no edit-capable model exists"
	)
	imagex._on_capabilities_received({
		"supported": true,
		"edit_supported": true,
		"models": ["legacy-a", "legacy-b"],
		"default_model": "legacy-b",
	})
	imagex._task_tabs.current_tab = 2
	imagex._on_task_mode_selected(2)
	_assert(
		imagex._image_edit_supported
		and imagex._edit_models == ["legacy-a", "legacy-b"]
		and imagex._model.item_count == 2
		and imagex._selected_option(imagex._model) == "legacy-b",
		"ImageX should treat all generation models as editable for an older capable Runtime"
	)
	var generated_preview_path := "res://addons/godetx/icons/godotx-mark.png"
	imagex._active_generation_id = "reskin_completion_test"
	imagex._active_task_mode = imagex.TASK_RESKIN
	imagex._on_generation_completed({
		"generation_id": "reskin_completion_test",
		"resource_path": generated_preview_path,
		"mode": "reskin",
		"output_width": 32,
		"output_height": 32,
	})
	_assert(
		imagex._active_generation_id.is_empty()
		and imagex._result_resource_path == generated_preview_path
		and imagex._last_result_preview_loaded
		and imagex._preview.texture != null
		and not imagex._preview_placeholder.visible
		and imagex._result_status_text == "Sprite reskin generated"
		and imagex._status.text == Localization.translate("Sprite reskin generated")
		and imagex._transient_status_until_ms == 0
		and imagex._result_scroll is ScrollContainer,
		"ImageX should display a completed reskin and retain its result state"
	)
	imagex._set_status("Ready", Color("72c98a"))
	imagex._apply_idle_status()
	_assert(
		imagex._status.text == Localization.translate("Sprite reskin generated"),
		"ImageX polling should not overwrite a completed reskin with Ready"
	)
	imagex._active_generation_id = "reskin_failure_test"
	imagex._active_task_mode = imagex.TASK_RESKIN
	imagex._on_generation_failed("reskin_failure_test", "Provider edit failed")
	imagex._set_status("Ready", Color("72c98a"))
	imagex._apply_idle_status()
	_assert(
		imagex._result_status_text == "Provider edit failed"
		and imagex._result_status_literal
		and imagex._status.text == "Provider edit failed"
		and imagex._transient_status_until_ms == 0,
		"ImageX should keep the real edit failure visible until another operation starts"
	)
	imagex._active_generation_id = "preview_failure_test"
	imagex._active_task_mode = imagex.TASK_RESKIN
	imagex._on_generation_completed({
		"generation_id": "preview_failure_test",
		"resource_path": "res://addons/godetx/localization.gd",
	})
	_assert(
		not imagex._last_result_preview_loaded
		and imagex._result_status_text == "Image was saved but its preview could not be loaded"
		and imagex._status.text == Localization.translate(
			"Image was saved but its preview could not be loaded"
		),
		"ImageX should not replace a preview decoding failure with a success status"
	)
	imagex.free()
	var skillx := SkillXContent.new()
	skillx.set_translation_domain(Localization.DOMAIN)
	skillx._build_ui()
	_assert(
		skillx._scope.get_item_text(0) == "项目"
		and skillx._scope.get_item_text(1) == "个人"
		and skillx._index_state.text == "离线"
		and skillx._skill_count.text == "0 个技能"
		and skillx._save_button.text == "保存技能"
		and skillx._delete_dialog.title == "删除技能"
		and skillx._instructions_input.placeholder_text == "仅在技能匹配时加载的可复用指令",
		"SkillX controls should use the plugin Chinese catalog"
	)
	skillx.free()
	_assert(TranslationServer.get_locale() == project_locale_before, "Plugin localization must not change the project locale")
	_assert(
		TranslationServer.translate(main_probe) == main_translation_before,
		"Plugin localization must not add messages to the main domain"
	)

	var dock := DockContent.new()
	dock.set_translation_domain(Localization.DOMAIN)
	dock._build_ui()
	_assert(dock._prompt.placeholder_text == "请 GodotX 检查或修改此项目", "Composer placeholder should be Chinese")
	_assert(
		dock._attachment_menu.tooltip_text == "添加视觉附件"
		and dock._attachment_menu.get_popup().get_item_text(0) == "从文件添加图片"
		and dock._attachment_menu.get_popup().get_item_text(1) == "添加项目资源预览",
		"Visual attachment controls should be Chinese"
	)
	_assert(dock._settings_dialog.title == "GodotX 设置", "Settings title should be Chinese")
	_assert(
		dock._annotation_dialog.title == "图片批注"
		and dock._annotation_tool_buttons[0].text == "箭头"
		and dock._annotation_tool_buttons[1].text == "矩形"
		and dock._annotation_tool_buttons[2].text == "圆圈"
		and dock._annotation_save_button.text == "保存批注",
		"Image annotation tools should follow the plugin locale"
	)
	_assert(dock._session_select.tooltip_text == "对话", "Conversation selector should be Chinese")
	_assert(dock._clear_button.tooltip_text == "新建对话", "New conversation action should be Chinese")
	_assert(dock._rename_session_dialog.title == "重命名对话", "Rename conversation dialog should be Chinese")
	_assert(dock._delete_session_dialog.title == "删除对话", "Delete conversation dialog should be Chinese")
	_assert(
		Localization.translate("Earlier") == "更早"
		and Localization.translate("Newer") == "更新",
		"Saved conversation pagination should be Chinese"
	)
	_assert(
		Localization.translate("The selected model does not support image input.")
		== "所选模型不支持图片输入。"
		and Localization.translate("Editor viewport returned an empty image")
		== "编辑器视口返回了空图片",
		"Visual input capability and capture errors should be localized"
	)
	_assert(
		dock._runtime_automation.text == "使用运行时自动化"
		and dock._runtime_automation.tooltip_text.contains("无需修改项目脚本"),
		"Runtime automation settings should explain the script-free simulation mode in Chinese"
	)
	_assert(dock._approval_dialog.get_ok_button().text == "批准", "Approval action should be Chinese")
	_assert(dock._approval_mode_select.get_item_text(0) == "请求批准", "Ask mode should be Chinese")
	_assert(dock._approval_mode_select.get_item_text(1) == "替我审批", "Automatic approval mode should be Chinese")
	_assert(
		dock._tool_title("read_file", {"path": "demo/main.gd"}) == "读取 demo/main.gd",
		"Dynamic tool titles should translate the template but preserve paths"
	)
	_assert(
		dock._tool_title("web_search", {"query": "Godot 4.6 文档"}) == "搜索网页：Godot 4.6 文档",
		"Web search titles should localize the action without translating the query"
	)
	_assert(
		dock._tool_title("web_open", {"url": "https://docs.godotengine.org/"})
		== "打开网页：https://docs.godotengine.org/",
		"Web open titles should localize the action without translating the URL"
	)
	_assert(
		dock._tool_title("game_debug_start", {
			"mode": "scene",
			"scene_path": "res://demo/main.tscn",
		}) == "调试 res://demo/main.tscn",
		"Game debug titles should be localized without translating scene paths"
	)
	dock._auto_approve_edits_enabled = true
	var localized_current_launch := dock._format_tool_arguments("game_debug_start", {
		"mode": "current",
		"scene_path": "/",
	})
	_assert(
		localized_current_launch.contains("游戏启动将自动获批。")
		and localized_current_launch.contains("已忽略附带的场景路径")
		and not localized_current_launch.contains("场景：/"),
		"Automatic game approval should be stated clearly in Chinese"
	)
	_assert(
		dock._tool_title("game_automation_run", {}) == "执行游戏自动化"
		and dock._tool_title("game_automation_status", {}) == "检查游戏自动化"
		and dock._tool_title("game_automation_cancel", {}) == "取消游戏自动化",
		"All runtime automation tool titles should be localized"
	)
	var localized_automation_arguments := dock._format_tool_arguments("game_automation_run", {
		"run_id": "run_auto",
		"steps": [
			{"type": "wait_frames", "frames": 3},
			{"type": "click_control", "node_path": "Menu/Start", "button": 1},
		],
		"stop_on_failure": true,
	})
	_assert(
		localized_automation_arguments.contains("运行 ID：run_auto")
		and localized_automation_arguments.contains("步骤数：2")
		and localized_automation_arguments.contains("1. 等待 3 帧")
		and localized_automation_arguments.contains("2. 点击 Menu/Start（按钮 1）"),
		"Runtime automation plan details should be readable in Chinese"
	)
	var localized_automation_reference := dock._format_tool_arguments("game_automation_cancel", {
		"run_id": "run_auto",
		"automation_id": "automation_auto",
	})
	_assert(
		localized_automation_reference.contains("自动化 ID：automation_auto"),
		"Runtime automation ownership arguments should be localized"
	)
	var localized_automation_output := dock._format_tool_output("game_automation_status", {
		"ok": true,
		"automation_id": "automation_auto",
		"run_id": "run_auto",
		"state": "failed",
		"current_step": 1,
		"step_count": 2,
		"failure": "未找到目标按钮",
	})
	_assert(
		localized_automation_output.contains("状态：失败")
		and localized_automation_output.contains("进度：1/2")
		and localized_automation_output.contains("失败原因：未找到目标按钮"),
		"Runtime automation results should localize status and failure labels"
	)
	_assert(
		dock._display_error("Runtime simulation automation is disabled in GodotX settings")
			== "GodotX 设置中的运行时模拟自动化尚未开启",
		"Runtime automation setting failures should be localized"
	)
	_assert(
		dock._display_error(
			"Current user request exceeds the safe context budget (12000 characters); shorten it or split it into smaller tasks"
		) == "当前请求过长，无法安全放入模型上下文。请缩短内容或拆分为多个任务。",
		"Oversized request failures should be actionable in Chinese"
	)
	_assert(
		dock._display_error(
			"The same normalized tool batch produced identical outputs twice without intervening progress; stopped before a third execution"
		) == "相同工具调用连续返回了未变化的结果，任务已停止。请先调整指令或项目状态再继续。"
		and dock._display_error(
			"Agent made no novel successful tool progress for 8 consecutive steps"
		) == "任务连续多次尝试仍未产生新的成功结果，已自动停止。请先调整指令或项目状态再继续。",
		"Adaptive loop stop reasons should be actionable in Chinese"
	)
	var localized_game_test_arguments := dock._format_tool_arguments("game_test", {
		"target": {"mode": "scene", "scene_path": "res://demo/main.tscn"},
		"steps": [
			{"type": "click_control", "node_path": "Menu/Start", "button": 1},
		],
		"cleanup": "on_success",
		"ready_timeout_ms": 5000,
		"automation_timeout_ms": 12000,
	})
	_assert(
		dock._tool_title("game_test", {
			"target": {"mode": "scene", "scene_path": "res://demo/main.tscn"},
		}) == "测试 res://demo/main.tscn"
		and localized_game_test_arguments.contains("模式：指定场景")
		and localized_game_test_arguments.contains("场景：res://demo/main.tscn")
		and localized_game_test_arguments.contains("步骤数：1")
		and localized_game_test_arguments.contains("失败时停止：是")
		and localized_game_test_arguments.contains("清理策略：仅成功时")
		and localized_game_test_arguments.contains("等待就绪超时：5000 毫秒")
		and localized_game_test_arguments.contains("自动化超时：12000 毫秒"),
		"Composite game-test targets and execution policy should be readable in Chinese"
	)
	var localized_game_test_output := dock._format_tool_output("game_test", {
		"ok": false,
		"state": "failed",
		"run_id": "run_test",
		"automation_id": "automation_test",
		"launch": {
			"start": {"ok": true, "run_id": "run_test"},
			"status": {
				"ok": true,
				"probe_active": true,
				"entries": [{"message": "游戏已启动"},],
			},
		},
		"automation": {
			"start": {"ok": true, "automation_id": "automation_test"},
			"status": {"state": "failed", "current_step": 1, "step_count": 2},
		},
		"cleanup": {
			"policy": "always",
			"attempted": true,
			"stop_attempted": true,
			"stop_requested": true,
			"stopped": true,
			"stop": {
				"ok": true,
				"stop_requested": true,
				"warning": "停止尚未确认",
			},
		},
		"stopped": true,
		"failure": "未找到目标按钮",
		"timings_ms": {"ready": 120, "automation": 400, "cleanup": 30, "total": 550},
	})
	_assert(
		localized_game_test_output.contains("状态：失败")
		and localized_game_test_output.contains("启动：就绪")
		and localized_game_test_output.contains("自动化：失败")
		and localized_game_test_output.contains("清理：已停止")
		and localized_game_test_output.contains("测试后游戏已停止。")
		and localized_game_test_output.contains("总耗时：550 毫秒")
		and localized_game_test_output.contains("阶段耗时：就绪 120 毫秒")
		and localized_game_test_output.contains("失败原因：未找到目标按钮")
		and localized_game_test_output.contains("最近测试输出（1 条）：")
		and localized_game_test_output.contains("游戏已启动")
		and localized_game_test_output.contains("警告：停止尚未确认"),
		"Composite game-test execution reports should be localized without changing identifiers"
	)
	_assert(
		dock._game_test_state_label("launch_failed") == "启动失败"
		and dock._game_test_state_label("ready_timeout") == "等待就绪超时"
		and dock._game_test_state_label("automation_failed") == "自动化失败"
		and dock._game_test_state_label("automation_timeout") == "自动化超时"
		and dock._game_test_state_label("cleanup_failed") == "清理失败"
		and dock._game_test_state_label("already_stopped") == "已经停止"
		and dock._game_test_phase_summary({
			"already_stopped": true,
			"attempted": false,
		}) == "已经停止",
		"Every composite game-test terminal state should have a Chinese label"
	)
	dock._begin_tool_message("localized_game_test", {
		"name": "game_test",
		"arguments": {"target": {"mode": "main"}, "steps": []},
	})
	dock._begin_tool_message("localized_read_delta", {
		"name": "read_file",
		"arguments": {"path": "demo/main.gd"},
	})
	var localized_game_test_phases: Dictionary = {
		"validating": "正在验证游戏测试\n",
		"starting": "正在启动游戏\n",
		"waiting_for_probe": "正在等待运行时探针\n",
		"running_automation": "正在执行游戏自动化\n",
		"cleaning_up": "正在清理游戏测试\n",
		"completed": "游戏测试已完成\n",
	}
	var all_game_test_phases_localized := true
	for phase in localized_game_test_phases:
		if dock._format_tool_output_delta("localized_game_test", {
			"phase": phase,
			"delta": "provider progress\n",
		}) != str(localized_game_test_phases[phase]):
			all_game_test_phases_localized = false
	_assert(
		all_game_test_phases_localized
		and dock._format_tool_output_delta("localized_game_test", {"delta": "原始进度"}) == "原始进度"
		and dock._format_tool_output_delta("localized_read_delta", {
			"phase": "starting",
			"delta": "raw read progress",
		}) == "raw read progress",
		"Composite game-test streaming phases should localize while raw deltas remain unchanged"
	)
	var localized_debug_arguments := dock._format_tool_arguments("game_debug_stop", {
		"run_id": "0123456789abcdef0123456789abcdef",
	})
	_assert(
		localized_debug_arguments.contains("运行 ID：0123456789abcdef0123456789abcdef"),
		"Game debug ownership arguments should be localized"
	)
	_assert(
		dock._display_error("GodotX does not own the currently running game") == "当前运行的游戏不归 GodotX 所有",
		"Game debug ownership failures should be localized"
	)
	var localized_arguments := dock._format_tool_arguments("scene_get_tree", {
		"scene_id": "scene_42",
		"root_path": ".",
		"max_depth": 4,
		"max_nodes": 50,
	})
	_assert(
		localized_arguments.contains("场景：scene_42")
		and localized_arguments.contains("最大深度：4")
		and localized_arguments.contains("最大节点数：50"),
		"Tool arguments should translate labels without translating identifiers"
	)
	var localized_web_arguments := dock._format_tool_arguments("web_open", {
		"url": "https://docs.godotengine.org/",
		"max_chars": 12000,
	})
	_assert(
		localized_web_arguments.contains("网址：https://docs.godotengine.org/")
		and localized_web_arguments.contains("正文上限：12000 字符"),
		"Web tool arguments should localize labels while preserving URLs and limits"
	)
	var localized_output := dock._format_tool_output("scene_apply_operations", {
		"ok": true,
		"operation_count": 2,
		"scene_path": "res://demo/main.tscn",
		"scene_revision": "history_1_v2",
	})
	_assert(
		localized_output.contains("已应用 2 个实时场景操作。")
		and localized_output.contains("场景：res://demo/main.tscn")
		and localized_output.contains("版本：history_1_v2"),
		"Tool output should translate its presentation without changing protocol values"
	)
	_assert(
		dock._message_label().auto_translate_mode == Node.AUTO_TRANSLATE_MODE_DISABLED
		and dock._approval_diff.auto_translate_mode == Node.AUTO_TRANSLATE_MODE_DISABLED,
		"User, model, tool output, and diff controls must not auto-translate project content"
	)
	dock.free()

	Localization.install_for_locale("en_US")
	var english_dock := DockContent.new()
	english_dock.set_translation_domain(Localization.DOMAIN)
	english_dock._build_ui()
	_assert(
		english_dock._prompt.placeholder_text == "Ask GodotX to inspect or change this project"
		and english_dock._approval_mode_select.get_item_text(0) == "Ask for approval"
		and english_dock._runtime_automation.text == "Use runtime automation"
		and english_dock._attachment_menu.tooltip_text == "Add visual attachment",
		"English should use source messages"
	)
	english_dock.free()

	Localization.install_for_locale("ja_JP")
	_assert(
		Localization.translate("Starting runtime") == "Starting runtime",
		"Unsupported system languages should fall back to English"
	)
	Localization.uninstall()
	_assert(not TranslationServer.has_domain(Localization.DOMAIN), "The plugin domain should be removed on shutdown")
	_assert(TranslationServer.get_locale() == project_locale_before, "Removing the plugin domain must preserve project locale")

	if not _failures.is_empty():
		for failure in _failures:
			printerr(failure)
		quit(1)
		return
	print("GODETX_LOCALIZATION_OK")
	quit(0)


func _assert(condition: bool, message: String) -> void:
	if not condition:
		_failures.append(message)
