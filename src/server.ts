import type { Stats } from "node:fs";

import fs from "node:fs/promises";
import ffss from "node:fs";  // bc some things are missing from fs/promises
import stream from "node:stream/promises";
import upath from "upath";
import http from "http";
import crypto from "crypto";
import chokidar from "chokidar";

import { args } from "./common";
import { StatusCodes } from "http-status-codes";

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
type Method = (
	url: URL,
	request: Request,
	response: Response,
) => void | Promise<void>;

if (process.argv.includes("--help")) {
	console.log(
		`Usage: ${process.platform === "win32" ? "TamperDAV.bat" : "./tamperdav.sh"} [options]
Starts a WebDAV server using Node.js

Options:
		--help                     Shows this information
		--config=[path]            Uses the specified config file (default: config.json)
		--meta-touch               Updates corresponding meta file upon changing a script
								   file, resulting in connected browsers syncing these changes
		--username=[username]      The username for clients to authenticate to the server with
		--password=[password]      The password for clients to authenticate to the server with
		--host=[host]              The network address to bind on (default: localhost)
		--port=[port]              The port that the server will listen on (default: 7000)
		--path=[path]              The path, relative to server.js, that will serve as storage
		--max-cursors=[amount]     The maximum number of cached changes the server will store
		--debug                    Provides some more detailed output for debugging purposes

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

if (!args.username || !args.password) {
	console.error(
		"TamperDAV is running without any form of authentication. " +
			"It's strongly recommended to configure username and password!",
	);
	process.exit(3);
}

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
].join(",");

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

function getRF(url: URL): [string, string] {
	const rpath = url.pathname;
	const fpath = upath.join(args.path, rpath);
	return [rpath, fpath];
}

async function checkPath(fpath: string, response: Response): Promise<boolean> {
	if (!fpath.startsWith(args.path)) {
		response.statusCode = StatusCodes.FORBIDDEN;
		response.end();
		return false;
	}
	return true;
}

async function checkExists(
	fpath: string,
	response: Response,
): Promise<boolean> {
	if (!(await exists(fpath))) {
		response.statusCode = StatusCodes.NOT_FOUND;
		response.end();
		return false;
	}
	return true;
}

const methods: { [key: string]: Method } = {
	async options(_, __, response) {
		response.setHeaders(
			new Headers({
				"Access-Control-Allow-Methods": ALLOWED_METHODS,
				"Access-Control-Allow-Credentials": "true",
				"Access-Control-Allow-Headers":
					"Authorization,User-Agent,Content-Type,Accept,Origin,X-Requested-With,Cursor",
			}),
		);
		response.statusCode = StatusCodes.OK;
		response.end();
	},
	async propfind(url, request, response) {
		const [rpath, fpath] = getRF(url);
		if (!(await checkPath(fpath, response))) return;
		if (!(await checkExists(fpath, response))) return;

		let xml;
		if ((await fs.stat(fpath)).isDirectory()) {
			const wc = watcherCache[rpath];
			const depth = parseeIntt(request.headers.depth);
			const cursor = depth !== 0 ? wc.currentCursor : undefined;
			const filenames = depth !== 0 ? await fs.readdir(fpath) : [];
			filenames.unshift(".");
			xml = arrayToXml(rpath, filenames, cursor);
		} else {
			xml = arrayToXml(rpath, [""]);
		}
		response.statusCode = StatusCodes.MULTI_STATUS;
		response.setHeader("Content-Type", "application/xml; charset=utf-8");
		response.end(xml);
	},
	async mkcol(url, request, response) {
		const [_, fpath] = getRF(url);
		if (!(await checkExists(fpath, response))) return;
		if (!(await exists(fpath))) {
			response.statusCode = StatusCodes.METHOD_NOT_ALLOWED;
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
			response.statusCode = StatusCodes.UNPROCESSABLE_ENTITY;
			response.end();
		}
	},
	async get(url, _, response) {
		const [__, fpath] = getRF(url);
		if (!(await checkPath(fpath, response))) return;
		if (!(await checkExists(fpath, response))) return;

		try {
			response.statusCode = StatusCodes.OK;
			response.setHeader("Content-Type", "application/octet-stream");
			await stream.pipeline(ffss.createReadStream(fpath), response);
			response.end();
		} catch (_err) {
			const err = _err as NodeJS.ErrnoException;
			if (err.code === "ERR_STREAM_PREMATURE_CLOSE") return;
			console.error(err);
			response.statusCode = StatusCodes.INTERNAL_SERVER_ERROR;
			const message =
				typeof err === "object" &&
				err !== null &&
				"message" in err &&
				typeof err.message === "string"
					? err.message
					: "Catastrophy";
			response.end(message);
		}
	},
	async put(url, request, response) {
		const [rpath, fpath] = getRF(url);
		if (!(await checkExists(fpath, response))) return;
		try {
			await stream.pipeline(request, ffss.createWriteStream(fpath));
			response.statusCode = StatusCodes.OK;
		} catch (err) {
			console.error(`PUT "${rpath}" failed`);
			console.error(err);
			response.statusCode = StatusCodes.INTERNAL_SERVER_ERROR;
		}
		response.end();
	},
	async delete(url, _, response) {
		const [rpath, fpath] = getRF(url);
		if (!(await checkExists(fpath, response))) return;
		try {
			await fs.unlink(fpath);
			response.statusCode = StatusCodes.NO_CONTENT;
		} catch (err) {
			console.error(`DELETE "${rpath}" failed`);
			console.error(err);
			response.statusCode = StatusCodes.NOT_FOUND;
		}
		response.end();
	},
	async head(url, _, response) {
		const [rpath, fpath] = getRF(url);
		if (!(await checkExists(fpath, response))) return;

		response.statusCode = StatusCodes.OK;
		let success = false;
		let stats: Stats | undefined;
		if (await exists(fpath)) {
			try {
				stats = await fs.stat(fpath);
			} catch (err) {
				console.error(`stat "${rpath}" failed`);
				console.error(err);
			}
			if (stats !== undefined) {
				response.setHeader("Content-Length", stats.size.toString());
				response.setHeader("Content-Type", "application/octet-stream");
				success = true;
			}
		}
		if (!success) {
			response.statusCode = StatusCodes.NOT_FOUND;
		}
		response.end();
	},
	async subscribe(url, request, response) {
		const [rpath, fpath] = getRF(url);
		if (!(await checkPath(fpath, response))) return;
		if (!(await checkExists(fpath, response))) return;

		if (!(await fs.stat(fpath)).isDirectory()) {
			response.statusCode = StatusCodes.BAD_REQUEST;
			response.end();
			return;
		}

		// const id = crypto.randomBytes(16).toString("hex");
		const id = crypto.randomUUID();
		const timeoutID = global.setTimeout(() => {
			delete subscribers[rpath][id];
			if (response.writableEnded) return;
			response.statusCode = StatusCodes.NO_CONTENT;
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
	const fpath = upath.join(args.path, rpath);

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
	return (
		'<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:td="http://dav.tampermonkey.net/ns">' +
		`${entriesStr}${newCursor}` +
		"</d:multistatus>"
	);
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
		response.statusCode = StatusCodes.MULTI_STATUS;
		response.setHeader("Content-Type", "application/xml; charset=utf-8");
		response.end(xml);
		global.clearTimeout(subscriber.timeout);
	}
}

const watcherCache: WatcherCache = {};
function sendCachedWatcherChanges(rpath: string, fromCursor: number): boolean {
	const entry = watcherCache[rpath];
	if (entry === undefined) return false;
	for (let i = fromCursor; i <= entry.currentCursor; i++) {
		const changes = entry.cursorChanges[i];
		if (changes) {
			notifySubscribers(rpath, Object.keys(changes), i + 1);
		}
	}

	const changeKeys = Object.keys(entry.cursorChanges).map(parseeIntt);
	if (changeKeys.length > 0 && changeKeys.length > args["max-cursors"]) {
		// TODO: m what is m as a variable name what does that mean
		const m = entry.currentCursor - args["max-cursors"] + 1;
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

	const fpath = upath.join(args.path, rpath);
	let entry: WatcherEntry | null = null;
	const onChange = async (_path: string) => {
		const path = upath.normalize(_path);
		const filename = path.replace(
			new RegExp("^" + RegExp.escape(fpath) + "\/?"),
			"",
		);
		if (args["meta-touch"]) {
			// TODO: what is m
			let m, meta, name;
			if (
				(m = path.match(/(.*)\.user.js$/)) !== null &&
				(name = m?.[1]) !== undefined &&
				(meta = `${name}.meta.json`) &&
				(await exists(meta))
			) {
				if (args.debug) console.debug("metatouch: ", meta);
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
	const methodName =
		url.searchParams.get("method") ?? request.method!.toLowerCase();

	request.on("error", (err) => console.error(err.stack));

	// if (args.debug) {
	// 	response.setHeader = debugWrapMethod(response.setHeader);
	// 	response.end = debugWrapMethod(response.end);
	// 	console.debug("request", methodName, request.url, request.headers);
	// }

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
		response.statusCode = StatusCodes.UNAUTHORIZED;
		response.end();
		return;
	}

	const method = methods[methodName];
	if (method === undefined) {
		console.log(`unknown method ${request.method}`);
		response.statusCode = StatusCodes.NOT_IMPLEMENTED;
		response.end();
	}

	response.setHeader(
		"Cache-Control",
		"no-store, no-cache, must-revalidate, post-check=0, pre-check=0",
	);
	response.setHeader("DAV", "1");
	return method(url, request, response);
};

const server = http.createServer(requestHandler);
const host = args.host ?? "localhost";

server.on("error", console.error);
server.listen(args.port, host, () => {
	console.log(`TamperDAV is listening on ${args.port}`);
});
