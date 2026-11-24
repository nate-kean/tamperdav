import fs from "node:fs";
import dialog from "dialog";
import upath from "upath";

export type Args = {
	username?: string;
	password?: string;
	path?: string;
	"max-cursors"?: number;
	host?: string;
	port?: number;
	"no-dialog"?: boolean;
	"no-auth-warning"?: boolean;
	headless?: boolean;
	"open-in-editor"?: boolean;
	"meta-touch"?: boolean;
	debug?: boolean;
	name?: string;
};

export let args: Args = {};

export function error(message: string): void {
	console.error(message);
	if (!args["no-dialog"] && !args.headless) {
		dialog.err(message, "TamperDAV");
	}
}

export function warn(message: string): void {
	console.warn(message);
	if (!args["no-dialog"] && !args.headless) {
		dialog.warn(message, "TamperDAV");
	}
}
// early parsing for the config option
const configPath =
	process.argv.reduce((a, c) => c.split("--config=")[1] || a, "") ||
	"config.json";
if (fs.existsSync(configPath)) {
	try {
		args = JSON.parse(fs.readFileSync(configPath, "utf8"));
	} catch (err) {
		const message =
			typeof err === "object" &&
			err !== null &&
			"message" in err &&
			typeof err.message === "string"
				? err.message
				: "Catastrophy";
		error(`${configPath}: ${message}`);
		process.exit(1);
	}
}

for (const key of ["username", "password"] as const) {
	args[key] = args[key] || process.env["TD_" + key.toUpperCase()];
}

for (const val of process.argv) {
	const s = val.replace(/^[-]{1,2}/, "").split("=");
	args[s[0]] = s[1] || true;
}


if (args.path === undefined) {
	error("path arguments missing");
	process.exit(1);
}

export const WORKING_DIR = upath.join("./", args.path);
if (!fs.existsSync(WORKING_DIR)) {
	error("working directory missing");
	process.exit(1);
}
