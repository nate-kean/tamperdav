import type { Stats } from "node:fs";

import fs from "node:fs/promises";
import upath from "upath";
import http from "http";
import crypto from "crypto";
import chokidar from "chokidar";
import open from "open";

import * as common from "./common";
import { args, WORKING_DIR } from "./common";

type Request = http.IncomingMessage;
type Response = http.ServerResponse;
type Handler = http.RequestListener<
	typeof http.IncomingMessage,
	typeof http.ServerResponse
>;
type Timeout = ReturnType<typeof global.setTimeout>;
type Subscribers = {
	[key: string]: Feed;
};
type Feed = {
	[key: string]: Subscriber;
};
type Subscriber = {
	response: Response;
	timeout: Timeout;
};
type WatcherEntry = {
	cursorChanges: {
		[key: number]: string[];
	};
	timeout: Timeout | null;
	currentCursor: number;
};
type WatcherCache = { [key: string]: WatcherEntry };
type Method = (url: URL, request: Request, response: Response) => Promise<void>;

if (process.argv.includes("--help")) {
	console.log(
		`Usage: ${process.platform === "win32" ? "TamperDAV.bat" : "./tamperdav.sh"} [options]
Starts a WebDAV server using Node.js

Options:
		--help                     Shows this information
		--config=[path]            Uses the specified config file (default: config.json)
		--no-auth-warning          Disables the warning regarding missing authentication due
								   to missing username and password
		--meta-touch               Updates corresponding meta file upon changing a script
								   file, resulting in connected browsers syncing these changes
		--debug                    Provides some more detailed output for debugging purposes
		--open-in-editor=[editor]  The editor to use when pressing the cloud editor icon in
								   Tampermonkey
		--open-in-editor           Same as above, but uses ${process.platform === "win32" ? "notepad.exe" : "the editor chosen by xdg-open"}
		--username=[username]      The username for clients to authenticate to the server with
		--password=[password]      The password for clients to authenticate to the server with
		--host=[host]              The network address to bind on (default: localhost)
		--port=[port]              The port that the server will listen on (default: 7000)
		--path=[path]              The path, relative to server.js, that will serve as storage
		--max-cursors=[amount]     The maximum number of cached changes the server will store
		--no-dialog                Disables the use of a dialog to show messages to the user
		--headless                 Implies --no-dialog and disables editor opening

All of these options except "--help" can be specified in a JSON formatted file config.json
in the same directory as server.js. An example is:
{
	"path": "dav",
	"meta-touch": true,
	"username": "foo",
	"password": "bar",
	"port": 1234
}

Options provided as command line parameters all have precedence over options stored in the
config file.

Username and password can also be specified in the environment variables TD_USERNAME and
TD_PASSWORD respectively. These have priority over over the config file, but not over the
command line parameters.
`,
	);
	process.exit(0);
}

if (!args["no-auth-warning"] && (!args.username || !args.password)) {
	common.warn(
		"TamperDAV is running without any form of authentication. " +
			"It's strongly recommended to configure username and password!",
	);
}

const port = args.port ?? 7000;
const maxCursors = args["max-cursors"] ?? 512;
const subscribers: Subscribers = {};
const ALLOWED_METHODS = [
	"GET",
	"HEAD",
	"OPTIONS",
	"PUT",
	"PROPFIND",
	"MKCOL",
	"DELETE",
	"SUBSCRIBE",
]
	.concat(args["open-in-editor"] ? ["EDITOR"] : [])
	.join(",");

async function exists(path: Parameters<typeof fs.access>[0]): Promise<boolean> {
	try {
		await fs.access(path, fs.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function parseeIntt(str: string | readonly string[] | undefined): number {
	// @ts-expect-error TS2345: parseInt accepts more types than TS acts like it does
	return parseInt(str, 10);
}

const methods: { [key: string]: Method } = {
	async options(_, __, response) {
		response.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
		response.setHeader("Access-Control-Allow-Credentials", "true");
		response.setHeader(
			"Access-Control-Allow-Headers",
			"Authorization,User-Agent,Content-Type,Accept,Origin,X-Requested-With,Cursor",
		);

		response.statusCode = 200;
		response.end();
	},
	async propfind(url, request, response) {
		const rpath = url.pathname;
		const fpath = upath.join(WORKING_DIR, rpath);

		if (!fpath.startsWith(WORKING_DIR)) {
			response.statusCode = 403;
			response.end();
			return;
		}

		if (!(await exists(fpath))) {
			response.statusCode = 404;
			response.end();
			return;
		}

		let xml;
		if (!(await fs.stat(fpath)).isDirectory()) {
			xml = arrayToXml(rpath, [""]);
		} else {
			const wc = watcherCache[rpath];
			const depth = parseeIntt(request.headers.depth);
			const files = depth !== 0 ? await fs.readdir(fpath) : [];

			xml = arrayToXml(
				rpath,
				["."].concat(files),
				wc && depth !== 0 ? wc.currentCursor : undefined,
			);
		}

		response.statusCode = 207;
		response.setHeader("Content-Type", "application/xml; charset=utf-8");
		response.end(xml);
	},
	async mkcol(url, request, response) {
		const rpath = url.pathname;
		const fpath = upath.join(WORKING_DIR, rpath);

		if (!fpath.startsWith(WORKING_DIR)) {
			response.statusCode = 403;
			response.end();
			return;
		}

		if (!(await exists(fpath))) {
			response.statusCode = 405;
			response.end(
				'<d:error xmlns:d="DAV:" xmlns:td="http://dav.tampermonkey.net/ns">' +
					"<td:exception>MethodNotAllowed</td:exception>" +
					"<td:message>The resource you tried to create already exists</td:message>" +
					"</d:error>",
			);
			return;
		}

		try {
			await fs.mkdir(fpath);
			return await methods.propfind(url, request, response);
		} catch {
			response.statusCode = 422;
			response.end();
		}
	},
	async get(url, _, response) {
		const rpath = url.pathname;
		const fpath = upath.join(WORKING_DIR, rpath);

		if (!fpath.startsWith(WORKING_DIR)) {
			response.statusCode = 403;
			response.end();
			return;
		}
		if (!(await exists(fpath))) {
			response.statusCode = 404;
			response.end();
		}

		let contents;
		try {
			contents = await fs.readFile(fpath);
			response.statusCode = 200;
			response.setHeader("Content-Type", "application/octet-stream");
		} catch (err) {
			console.error(err);
			response.statusCode = 500;
			contents = err.message;
		} finally {
			response.end(contents);
		}
	},
	async editor(url, request, response) {
		const useEditor = args["open-in-editor"];
		if (!useEditor || args.headless) {
			response.statusCode = 501;
			response.end();
			return;
		}
		let editorPath;
		if (useEditor) {
			if (process.platform == "win32") {
				editorPath = "notepad";
			} else {
				editorPath = "xdg-open";
			}
		}

		const rpath = url.pathname;
		const fpath = upath.join(WORKING_DIR, rpath);

		if (!fpath.startsWith(WORKING_DIR)) {
			response.statusCode = 403;
			response.end();
			return;
		}
		if (!(await exists(fpath))) {
			response.statusCode = 404;
			response.end();
			return;
		}

		open(upath.resolve(fpath), { app: editorPath });
		response.setHeader(
			"Location",
			`dav://${request.headers.host}${url.pathname}`,
		);
		response.statusCode = 302;
		response.end();
	},
	async put(url, request, response) {
		const rpath = url.pathname;
		const fpath = upath.join(WORKING_DIR, rpath);

		if (!fpath.startsWith(WORKING_DIR)) {
			response.statusCode = 403;
			response.end();
			return;
		}

		const data: Buffer[] = [];
		request.on("data", data.push);

		request.on("end", async () => {
			await fs.writeFile(fpath, Buffer.concat(data));

			const timestamp = request.headers["x-oc-mtime"];
			if (typeof timestamp === "string") {
				try {
					await fs.utimes(fpath, timestamp, timestamp);
					response.setHeader("X-OC-Mtime", "accepted");
				} catch (err) {
					console.error(
						`setting mtime ${timestamp} failed`,
						err.message,
					);
				}
			}

			response.statusCode = 200;
			response.end();
		});
	},
	async delete(url, _, response) {
		const rpath = url.pathname;
		const fpath = upath.join(WORKING_DIR, rpath);

		if (!fpath.startsWith(WORKING_DIR)) {
			response.statusCode = 403;
			response.end();
			return;
		}

		try {
			await fs.unlink(fpath);
			response.statusCode = 204;
			response.end();
		} catch (err) {
			console.error(`deleting file ${rpath} failed`, err.message);
			response.statusCode = 404;
			response.end();
		}
	},
	async head(url, _, response) {
		const rpath = url.pathname;
		const fpath = upath.join(WORKING_DIR, rpath);

		if (!fpath.startsWith(WORKING_DIR)) {
			response.statusCode = 403;
			response.end();
			return;
		}

		let success = false;
		let stats: Stats | undefined;
		if (await exists(fpath)) {
			try {
				stats = await fs.stat(fpath);
			} catch (err) {
				console.error(`stat file ${rpath} failed`, err.message);
			}
			if (stats !== undefined) {
				response.statusCode = 200;
				response.setHeader("Content-Length", stats.size.toString());
				response.setHeader("Content-Type", "application/octet-stream");
				response.end();
				success = true;
			}
		}
		if (!success) {
			response.statusCode = 404;
			response.end();
		}
	},
	async subscribe(url, request, response) {
		const rpath = url.pathname;
		const fpath = upath.join(WORKING_DIR, rpath);

		if (!fpath.startsWith(WORKING_DIR)) {
			response.statusCode = 403;
			response.end();
			return;
		}
		if (!(await exists(fpath))) {
			response.statusCode = 404;
			response.end();
			return;
		}
		if (!(await fs.stat(fpath)).isDirectory()) {
			response.statusCode = 400;
			response.end();
			return;
		}

		const id = crypto.randomBytes(16).toString("hex");
		const timeoutID = global.setTimeout(function () {
			delete subscribers[rpath][id];

			if (response.writableEnded) return;

			response.statusCode = 204;
			response.end();
		}, 90 * 1_000);

		subscribers[rpath] = subscribers[rpath] ?? {};
		subscribers[rpath][id] = {
			response: response,
			timeout: timeoutID,
		};

		assureWatcher(rpath);

		const fromCursor =
			url.searchParams.get("cursor") ?? request.headers.cursor;
		sendCachedWatcherChanges(rpath, parseeIntt(fromCursor));
	},
};

async function arrayToXml(
	rpath: string,
	filenames: readonly string[],
	cursor?: number,
) {
	const fpath = upath.join(WORKING_DIR, rpath);

	const entries: string[] = [];
	for (const filename of filenames) {
		const cpath = upath.join(fpath, filename);

		let mtime = new Date();
		let size = -1;
		let isDir = false;
		try {
			const stats = await fs.stat(cpath);
			size = stats.size;
			mtime = stats.mtime;
			isDir = stats.isDirectory();
		} catch {}

		const lastModified = mtime.toUTCString();

		return [
			"<d:response>",
			`<d:href>${upath.join(rpath, filename)}</d:href>`,
			"<d:propstat>",
			"<d:prop>",
			`<d:getlastmodified>${lastModified}</d:getlastmodified>`,
			isDir
				? "<d:resourcetype><d:collection/></d:resourcetype>"
				: "<d:resourcetype />",
			isDir
				? "<d:getcontentlength />"
				: `<d:getcontentlength>${size}</d:getcontentlength>`,
			"</d:prop>",
			"<d:status>HTTP/1.1 200 OK</d:status>",
			"</d:propstat>",
			"</d:response>",
		].join("\n");
	}
	const entriesStr = entries.join("\n");
	const newCursor = cursor ? `<td:cursor>${cursor}</td:cursor>` : "";
	return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:td="http://dav.tampermonkey.net/ns">${entriesStr}${newCursor}</d:multistatus>`;
}

function notifySubscribers(
	rpath: string,
	filenames: readonly string[],
	cursor?: number,
): void {
	const feed = subscribers[rpath];
	if (feed === undefined) return;
	subscribers[rpath] = {}; // clear that thang
	const xml = arrayToXml(rpath, filenames, cursor);

	for (const key in feed) {
		const subscriber = feed[key];
		const response = subscriber.response;
		response.statusCode = 207;
		response.setHeader("Content-Type", "application/xml; charset=utf-8");
		response.end(xml);
		global.clearTimeout(subscriber.timeout);
	}
}

const watcherCache: WatcherCache = {};
function sendCachedWatcherChanges(rpath: string, fromCursor: number): boolean {
	let entry = watcherCache[rpath];
	if (entry === undefined) return false;
	for (let i = fromCursor; i <= entry.currentCursor; i++) {
		const changes = entry.cursorChanges[i];
		if (changes) {
			notifySubscribers(rpath, Object.keys(changes), i + 1);
		}
	}

	const changeKeys = Object.keys(entry.cursorChanges).map(parseeIntt);
	if (changeKeys.length > 0 && changeKeys.length > maxCursors) {
		const m = entry.currentCursor - maxCursors + 1;
		for (const changeKey of changeKeys) {
			if (changeKey < m) {
				delete entry.cursorChanges[changeKey];
			}
		}
	}

	return true;
}

const watchers: { [key: string]: chokidar.FSWatcher } = {};
function assureWatcher(rpath: string) {
	if (watchers[rpath]) return;

	const fpath = upath.join(WORKING_DIR, rpath);
	let entry: WatcherEntry | null = null;
	const onChange = async (_path: string) => {
		const path = upath.normalize(_path);
		const filename = path.replace(
			new RegExp("^" + RegExp.escape(fpath) + "\/?"),
			"",
		);
		if (args["meta-touch"]) {
			let m, meta, n;
			if (
				(m = path.match(/(.*)\.user.js$/)) !== null &&
				(n = m?.[1]) !== undefined &&
				(meta = `${n}.meta.json`) &&
				await exists(meta)
			) {
				if (args.debug) console.log("metatouch: ", meta);
				try {
					const now = new Date();
					await fs.utimes(meta, now, now);
				} catch (err) {
					console.error(err);
				}
			}
		}
		if (entry === null) {
			entry = watcherCache[rpath] = {
				cursorChanges: {},
				timeout: null,
				currentCursor: 1,
			};
		}
		if (entry.cursorChanges[entry.currentCursor] === undefined) {
			entry.cursorChanges[entry.currentCursor] = [];
		}
		const changes = entry.cursorChanges[entry.currentCursor];
		if (!changes.includes(filename)) {
			changes.push(filename);
		}

		if (entry.timeout) {
			global.clearTimeout(entry.timeout);
		}
		// collect all changes until there is no change for one second
		entry.timeout = global.setTimeout(() => {
			sendCachedWatcherChanges(rpath, entry!.currentCursor);
			const obj = watcherCache[rpath];
			obj.timeout = null;
			entry!.currentCursor++;
		}, 1000);
	};
	const watcher = chokidar.watch(fpath, {
		ignored: /^\./,
		atomic: true,
		ignoreInitial: true,
	});

	watcher
		.on("add", onChange)
		.on("change", onChange)
		.on("unlink", onChange)
		.on("error", () => {
			if (entry === null) return;
			for (const changes of Object.values(entry.cursorChanges)) {
				notifySubscribers(rpath, changes);
			}
		});

	watchers[rpath] = watcher;
}

// function debugWrapMethod<T extends (this: any, ...args: any[]) => any>(
// 	fn: T,
// ): (this: ThisParameterType<T>, ...args: Parameters<T>) => ReturnType<T> {
// 	return function (
// 		this: ThisParameterType<T>,
// 		...args: Parameters<T>
// 	): ReturnType<T> {
// 		console.debug(fn.name, args);
// 		return fn.apply(this, args);
// 	};
// }

const requestHandler: Handler = (request, response) => {
	const url = new URL(request.url!);
	const method =
		url.searchParams.get("method") ?? request.method!.toLowerCase();

	request.on("error", (err) => console.error(err.stack));

	// if (args.debug) {
	// 	response.setHeader = debugWrapMethod(response.setHeader);
	// 	response.end = debugWrapMethod(response.end);
	// 	console.debug("request", method, request.url, request.headers);
	// }

	if (args.username || args.password) {
		let a, b, c; // Auth, Basic, Creds :)
		if (
			(a = request.headers.authorization) === undefined ||
			(b = a.match("Basic (.*)")?.[1]) === undefined ||
			(c = btoa(b).split(":")).length === 0 ||
			c[0] !== args.username ||
			c[1] !== args.password
		) {
			response.setHeader(
				"WWW-Authenticate",
				'Basic realm="Enter credentials"',
			);
			response.statusCode = 401;
			response.end();
			return;
		}
	}

	if (!(method in methods)) {
		console.log(`unknown method ${request.method}`);
		response.statusCode = 501;
		response.end();
	}
	response.setHeader(
		"Cache-Control",
		"no-store, no-cache, must-revalidate, post-check=0, pre-check=0",
	);
	response.setHeader("DAV", "1");

	return methods[method](url, request, response);
};

const server = http.createServer(requestHandler);
const host = args.host ?? "localhost";

server.on("error", console.error);
server.listen(port, host, () => {
	console.log(`TamperDAV is listening on ${port}`);
});
