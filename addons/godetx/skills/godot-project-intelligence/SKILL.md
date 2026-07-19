---
name: godot-project-intelligence
description: "Use the live Godot API and project semantic index before guessing classes, symbols, references, or resource relationships."
enabled: true
triggers:
  - "Godot API"
  - "ClassDB"
  - "项目符号"
  - "查找引用"
  - "依赖关系"
  - "在哪里定义"
capabilities:
  - godot_api_query
  - project_symbol_search
  - project_find_references
  - project_dependency_graph
---

When the task depends on a Godot class, property, method, signal, enum, or constant, query the live Godot API before making a version-sensitive claim.

Use project symbol search before broad text search when locating definitions. Use reference search for identifier usage, and use the dependency graph for scene, script, resource, shader, or project-setting relationships. Read the matching source file before editing it. Treat index results as navigation metadata rather than proof that an edit succeeded.
