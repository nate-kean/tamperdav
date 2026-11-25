import fs from "node:fs";
import upath from "upath";

export type Args = {
	username?: string;
	password?: string;
	path: string;
	"max-cursors": number;
	host?: string;
	port: number;
	"meta-touch": boolean;
	debug: boolean;
	name?: string;
};

export let args: Args = {
	port: 7000,
	"max-cursors": 512,
	path: "./",
	"meta-touch": false,
	debug: false,
};

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
		console.error(`${configPath}: ${message}`);
		process.exit(4);
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
	console.error("path arguments missing");
	process.exit(1);
}

args.path = upath.join("./", args.path);
if (!fs.existsSync(args.path)) {
	console.error("working directory missing");
	process.exit(2);
}
