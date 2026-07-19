import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve("node_modules");
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, ".gdignore"), "", "utf8");
