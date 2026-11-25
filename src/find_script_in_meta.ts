// USAGE: ./find_script_in_meta.js [--name="My script"]

import fs from "node:fs/promises";
import upath from "upath";

import { args } from "./common";

for await (const filename of fs.glob(
	`${upath.join("./", args.path)}/**/*.meta.json`,
)) {
	fs.readFile(filename, "utf-8").then(contents => {
		let json;
		try {
			json = JSON.parse(contents);
		} catch {
			return;
		}
		if (args.name !== undefined && json.name !== args.name) return;
		console.log(`${filename} => ${json.name}`);
	});
}
