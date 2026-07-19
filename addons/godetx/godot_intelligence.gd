@tool
extends RefCounted

const DEFAULT_LIMIT := 64
const MAX_LIMIT := 256
const MAX_QUERY_LENGTH := 128
const MAX_METHOD_ARGUMENTS := 64
const MAX_ENUM_VALUES := 256


func execute(args: Dictionary) -> Dictionary:
	var action := str(args.get("action", "search")).strip_edges()
	match action:
		"search":
			return _search_classes(args)
		"describe":
			return _describe_class(args)
		"inheriters":
			return _class_inheriters(args)
		_:
			return _error("action must be search, describe, or inheriters")


func _search_classes(args: Dictionary) -> Dictionary:
	var query_result := _safe_query(args.get("query", ""), true)
	if not bool(query_result.get("ok", false)):
		return query_result
	var query := str(query_result.get("value", "")).to_lower()
	var limit := _bounded_limit(args.get("limit", DEFAULT_LIMIT))
	if limit < 0:
		return _error("limit must be an integer from 1 to %d" % MAX_LIMIT)
	var matches: Array[Dictionary] = []
	for class_value in ClassDB.get_class_list():
		var class_name_value := str(class_value)
		if not query.is_empty() and not class_name_value.to_lower().contains(query):
			continue
		matches.append({
			"name": class_name_value,
			"parent": str(ClassDB.get_parent_class(class_name_value)),
			"source": "engine",
			"api_type": int(ClassDB.class_get_api_type(class_name_value)),
			"instantiable": ClassDB.can_instantiate(class_name_value),
		})
	for class_value in ProjectSettings.get_global_class_list():
		if not class_value is Dictionary:
			continue
		var descriptor: Dictionary = class_value
		var class_name_value := str(descriptor.get("class", ""))
		if class_name_value.is_empty() or (not query.is_empty() and not class_name_value.to_lower().contains(query)):
			continue
		matches.append({
			"name": class_name_value,
			"parent": str(descriptor.get("base", "")),
			"source": "script",
			"path": str(descriptor.get("path", "")),
			"language": str(descriptor.get("language", "")),
		})
	matches.sort_custom(_sort_class_matches.bind(query))
	var truncated := matches.size() > limit
	if truncated:
		matches.resize(limit)
	return {
		"ok": true,
		"action": "search",
		"query": str(query_result.get("value", "")),
		"classes": matches,
		"truncated": truncated,
		"engine": _engine_version(),
	}


func _describe_class(args: Dictionary) -> Dictionary:
	var class_result := _safe_identifier(args.get("class_name", ""), "class_name")
	if not bool(class_result.get("ok", false)):
		return class_result
	var class_name_value := str(class_result.get("value", ""))
	if not ClassDB.class_exists(class_name_value):
		return _describe_script_class(class_name_value)
	var member_result := _safe_query(args.get("member_query", ""), true)
	if not bool(member_result.get("ok", false)):
		return member_result
	var member_query := str(member_result.get("value", "")).to_lower()
	var include_inherited := bool(args.get("include_inherited", true))
	var no_inheritance := not include_inherited
	var limit := _bounded_limit(args.get("limit", DEFAULT_LIMIT))
	if limit < 0:
		return _error("limit must be an integer from 1 to %d" % MAX_LIMIT)
	var properties := _normalize_property_list(
		ClassDB.class_get_property_list(class_name_value, no_inheritance),
		member_query,
		limit
	)
	var methods := _normalize_method_list(
		ClassDB.class_get_method_list(class_name_value, no_inheritance),
		member_query,
		limit
	)
	var signals := _normalize_method_list(
		ClassDB.class_get_signal_list(class_name_value, no_inheritance),
		member_query,
		limit
	)
	var enums := _normalize_enum_list(class_name_value, no_inheritance, member_query, limit)
	var constants := _normalize_constant_list(class_name_value, no_inheritance, member_query, limit)
	return {
		"ok": true,
		"action": "describe",
		"class": {
			"name": class_name_value,
			"parent": str(ClassDB.get_parent_class(class_name_value)),
			"source": "engine",
			"api_type": int(ClassDB.class_get_api_type(class_name_value)),
			"enabled": ClassDB.is_class_enabled(class_name_value),
			"instantiable": ClassDB.can_instantiate(class_name_value),
		},
		"include_inherited": include_inherited,
		"member_query": str(member_result.get("value", "")),
		"properties": properties,
		"methods": methods,
		"signals": signals,
		"enums": enums,
		"constants": constants,
		"engine": _engine_version(),
	}


func _describe_script_class(class_name_value: String) -> Dictionary:
	for class_value in ProjectSettings.get_global_class_list():
		if not class_value is Dictionary:
			continue
		var descriptor: Dictionary = class_value
		if str(descriptor.get("class", "")) != class_name_value:
			continue
		return {
			"ok": true,
			"action": "describe",
			"class": {
				"name": class_name_value,
				"parent": str(descriptor.get("base", "")),
				"source": "script",
				"path": str(descriptor.get("path", "")),
				"language": str(descriptor.get("language", "")),
			},
			"note": "Use project_symbol_search and read_file for script-defined members.",
			"engine": _engine_version(),
		}
	return _error("Godot class does not exist: %s" % class_name_value)


func _class_inheriters(args: Dictionary) -> Dictionary:
	var class_result := _safe_identifier(args.get("class_name", ""), "class_name")
	if not bool(class_result.get("ok", false)):
		return class_result
	var class_name_value := str(class_result.get("value", ""))
	if not ClassDB.class_exists(class_name_value):
		return _error("Godot engine class does not exist: %s" % class_name_value)
	var limit := _bounded_limit(args.get("limit", DEFAULT_LIMIT))
	if limit < 0:
		return _error("limit must be an integer from 1 to %d" % MAX_LIMIT)
	var inheriter_values := ClassDB.get_inheriters_from_class(class_name_value)
	var inheriters: Array[String] = []
	for inheriter in inheriter_values:
		inheriters.append(str(inheriter))
	inheriters.sort()
	var truncated := inheriters.size() > limit
	if truncated:
		inheriters.resize(limit)
	return {
		"ok": true,
		"action": "inheriters",
		"class_name": class_name_value,
		"inheriters": inheriters,
		"truncated": truncated,
		"engine": _engine_version(),
	}


func _normalize_property_list(values: Array, query: String, limit: int) -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	for value in values:
		if not value is Dictionary:
			continue
		var descriptor: Dictionary = value
		var name := str(descriptor.get("name", ""))
		if name.is_empty() or (not query.is_empty() and not name.to_lower().contains(query)):
			continue
		result.append(_normalize_property_info(descriptor))
		if result.size() >= limit:
			break
	return result


func _normalize_method_list(values: Array, query: String, limit: int) -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	for value in values:
		if not value is Dictionary:
			continue
		var descriptor: Dictionary = value
		var name := str(descriptor.get("name", ""))
		if name.is_empty() or (not query.is_empty() and not name.to_lower().contains(query)):
			continue
		var arguments: Array[Dictionary] = []
		var args_value = descriptor.get("args", [])
		if args_value is Array:
			for argument_value in (args_value as Array).slice(0, MAX_METHOD_ARGUMENTS):
				if argument_value is Dictionary:
					arguments.append(_normalize_property_info(argument_value))
		var method: Dictionary = {
			"name": name,
			"arguments": arguments,
			"arguments_truncated": args_value is Array and (args_value as Array).size() > MAX_METHOD_ARGUMENTS,
			"flags": int(descriptor.get("flags", 0)),
		}
		var return_value = descriptor.get("return", {})
		if return_value is Dictionary:
			method["return"] = _normalize_property_info(return_value)
		result.append(method)
		if result.size() >= limit:
			break
	return result


func _normalize_enum_list(class_name_value: String, no_inheritance: bool, query: String, limit: int) -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	for enum_value in ClassDB.class_get_enum_list(class_name_value, no_inheritance):
		var enum_name := str(enum_value)
		if not query.is_empty() and not enum_name.to_lower().contains(query):
			continue
		var entries: Array[Dictionary] = []
		var enum_constants := ClassDB.class_get_enum_constants(class_name_value, enum_name, no_inheritance)
		for constant_value in enum_constants.slice(0, MAX_ENUM_VALUES):
			var constant_name := str(constant_value)
			entries.append({
				"name": constant_name,
				"value": ClassDB.class_get_integer_constant(class_name_value, constant_name),
			})
		result.append({
			"name": enum_name,
			"bitfield": ClassDB.is_class_enum_bitfield(class_name_value, enum_name, no_inheritance),
			"values": entries,
			"values_truncated": enum_constants.size() > MAX_ENUM_VALUES,
		})
		if result.size() >= limit:
			break
	return result


func _normalize_constant_list(class_name_value: String, no_inheritance: bool, query: String, limit: int) -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	for constant_value in ClassDB.class_get_integer_constant_list(class_name_value, no_inheritance):
		var constant_name := str(constant_value)
		if not query.is_empty() and not constant_name.to_lower().contains(query):
			continue
		result.append({
			"name": constant_name,
			"value": ClassDB.class_get_integer_constant(class_name_value, constant_name),
			"enum": str(ClassDB.class_get_integer_constant_enum(class_name_value, constant_name, no_inheritance)),
		})
		if result.size() >= limit:
			break
	return result


func _normalize_property_info(value: Dictionary) -> Dictionary:
	var type_id := int(value.get("type", TYPE_NIL))
	var result: Dictionary = {
		"name": str(value.get("name", "")),
		"type": type_string(type_id),
		"type_id": type_id,
		"usage": int(value.get("usage", 0)),
	}
	var class_name_value := str(value.get("class_name", ""))
	if not class_name_value.is_empty():
		result["class_name"] = class_name_value
	var hint := int(value.get("hint", PROPERTY_HINT_NONE))
	if hint != PROPERTY_HINT_NONE:
		result["hint"] = hint
	var hint_string := str(value.get("hint_string", ""))
	if not hint_string.is_empty():
		result["hint_string"] = hint_string.left(2048)
	return result


func _safe_identifier(value, field: String) -> Dictionary:
	var text := str(value).strip_edges()
	if text.is_empty() or text.length() > MAX_QUERY_LENGTH or not text.is_valid_identifier():
		return _error("%s must be a valid Godot identifier of at most %d characters" % [field, MAX_QUERY_LENGTH])
	return {"ok": true, "value": text}


func _safe_query(value, allow_empty: bool) -> Dictionary:
	var text := str(value).strip_edges()
	if (not allow_empty and text.is_empty()) or text.length() > MAX_QUERY_LENGTH:
		return _error("query must contain at most %d characters" % MAX_QUERY_LENGTH)
	for character in text:
		var code := character.unicode_at(0)
		if code < 32 or code == 127:
			return _error("query contains unsupported control characters")
	return {"ok": true, "value": text}


func _bounded_limit(value) -> int:
	if not (value is int or value is float):
		return -1
	var numeric := int(value)
	if float(numeric) != float(value) or numeric < 1 or numeric > MAX_LIMIT:
		return -1
	return numeric


func _engine_version() -> Dictionary:
	var version := Engine.get_version_info()
	return {
		"string": str(version.get("string", Engine.get_version_info().get("string", ""))),
		"major": int(version.get("major", 0)),
		"minor": int(version.get("minor", 0)),
		"patch": int(version.get("patch", 0)),
		"status": str(version.get("status", "")),
	}


func _sort_class_matches(left: Dictionary, right: Dictionary, query: String) -> bool:
	var left_name := str(left.get("name", "")).to_lower()
	var right_name := str(right.get("name", "")).to_lower()
	var left_exact := not query.is_empty() and left_name == query
	var right_exact := not query.is_empty() and right_name == query
	if left_exact != right_exact:
		return left_exact
	var left_prefix := not query.is_empty() and left_name.begins_with(query)
	var right_prefix := not query.is_empty() and right_name.begins_with(query)
	if left_prefix != right_prefix:
		return left_prefix
	return left_name < right_name


static func _error(message: String) -> Dictionary:
	return {"ok": false, "error": message}
