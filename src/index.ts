/**
 * Launch Picker — configure a session before the conversation starts.
 *
 * Manages five things:
 * - Active tool set (pi.setActiveTools), including the fully-clean "(none)" state.
 * - System prompt: replaced wholesale per turn via before_agent_start, from
 *   preset files in ~/.pi/agent/system-prompts/*.md. Special presets:
 *   "(default)" = pi's built-in prompt, "(empty)" = no system prompt, so the
 *   user message is the only prompt content.
 * - Skill advertisement: an allowlist filters the skills block pi injects into
 *   the system prompt. /skill:<name> stays usable — only model auto-selection is
 *   narrowed.
 * - Plugin contribution filter: an extension allowlist drops tools and packaged
 *   skills/prompt templates contributed by every other extension. Plugins
 *   themselves cannot be unloaded at runtime, so their commands and hooks stay.
 * - Named profiles persisted to ~/.pi/agent/launch-profiles.json, each bundling
 *   a tool set, a prompt preset, a skill allowlist and an extension allowlist.
 *   List entries are absolute by default; a "+name" / "-name" entry makes the
 *   whole list relative, adding to / removing from the state it is applied to.
 *
 * Behavior:
 * - Every session starts on pi's own defaults: the configured default tool
 *   selection (`defaultTools`, so `codemode` etc. stay on) and the built-in
 *   system prompt. No saved profile is applied implicitly — a stale profile
 *   must never be able to strip a session of its tools and system prompt.
 * - A profile is applied only when explicitly requested:
 *   `--lp-profile <name>`, `/lprofile <name>`, `/lpick`, ctrl+shift+l, or the
 *   `launchPicker.startup` setting ("session" | "last") for people who want the
 *   old auto-resume behavior.
 * - In the auto-apply modes, only when nothing is saved and the UI is a real
 *   terminal does the interactive picker run: profile -> (optional custom flow)
 *   tools -> plugins -> skills -> prompt.
 *
 * Commands:
 * - /lpick            open the interactive picker
 * - /lprofile [name]  apply a profile; no argument opens the picker;
 *                     /lprofile (none) clears back to defaults
 * - /lprompt [name]   set the system prompt preset ("(default)", "(empty)",
 *                     or a preset name); no argument opens a selector
 * - /ltools <spec>    set active tools: "all", "none", or a csv of tool names;
 *                     "+name" / "-name" add to or remove from the current set
 * - /lskills <spec>   skill allowlist: "all", "none", or a csv of skill names
 *                     (same +name / -name prefixes)
 * - /lplugins <spec>  extension allowlist: "all", "none", or a csv of plugin ids
 *                     (same +name / -name prefixes)
 * - /lsave <name>     save current tools + prompt + skills + plugins as a profile
 * - /lstate [prompt]  show session state: active tools, skills, plugins,
 *                     system prompt (with "prompt" argument: dump full prompt)
 *
 * Shortcut: ctrl+shift+l opens the picker.
 *
 * App (RPC) integration:
 * - Dialogs degrade to extension_ui_request (select/input), which the app
 *   answers over extension_ui_response.
 * - The app can apply configurations without any dialog, e.g.:
 *     {"type":"prompt","message":"/lprofile clean"}
 *     {"type":"prompt","message":"/ltools read,bash,edit"}
 *     {"type":"prompt","message":"/lprompt research"}
 *     {"type":"prompt","message":"/lskills docx,pdf"}
 *     {"type":"prompt","message":"/lplugins pi-todo,builtin:codemode"}
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Skill, SourceInfo, Theme } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt, getAgentDir } from "@earendil-works/pi-coding-agent";

interface Profile {
	/** Tools to activate. Plain names replace the active set; omit to leave tools untouched. */
	tools?: string[];
	/** Prompt preset name, or "(default)" / "(empty)". Omitted: prompt untouched. */
	prompt?: string;
	/** Skill allowlist advertised to the model. Omitted: all skills. */
	skills?: string[];
	/** Extension allowlist. Omitted: every extension's tools and packaged skills. */
	extensions?: string[];
}

/**
 * How one list is read: absolute (its names replace the current selection) or
 * relative (`+name` adds, `-name` removes). A list carrying both forms is
 * ambiguous, so callers reject it instead of guessing which half was meant.
 */
interface ListSpec {
	mode: "absolute" | "delta";
	plain: string[];
	add: string[];
	remove: string[];
}

function parseList(entries: readonly string[]): ListSpec {
	const plain: string[] = [];
	const add: string[] = [];
	const remove: string[] = [];
	for (const entry of entries) {
		const name = entry.slice(1).trim();
		if (entry.startsWith("+") && name) add.push(name);
		else if (entry.startsWith("-") && name) remove.push(name);
		else if (entry.trim()) plain.push(entry.trim());
	}
	return { mode: add.length === 0 && remove.length === 0 ? "absolute" : "delta", plain, add, remove };
}

interface ProfilesFile {
	last?: string;
	profiles: Record<string, Profile>;
}

const DEFAULT_PROMPT = "(default)";
const EMPTY_PROMPT = "(empty)";
const NONE_CHOICE = "(none)";
const CUSTOM_CHOICE = "(new custom…)";

/**
 * Built-in tools are not plugin-owned, so an extension allowlist never removes them.
 * `builtin:<name>` paths that are not in this set belong to a built-in extension
 * (codemode, tool-search, mcp, llama.cpp) and are filterable like any other plugin.
 */
const CORE_TOOL_PATHS = new Set(
	["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"].map((name) => `builtin:${name}`),
);

const TOOLS_TITLE = "Tools — space: toggle, enter: confirm, esc: cancel";
const PLUGINS_TITLE = "Plugins — unchecked plugins lose their tools, skills and prompts";
const SKILLS_TITLE = "Skills — unchecked skills are no longer advertised to the model";

const PROFILES_FILE = join(getAgentDir(), "launch-profiles.json");
const PROMPTS_DIR = join(getAgentDir(), "system-prompts");

/**
 * How a session starts: "default" (pi's own tools + built-in prompt), "session"
 * (also re-apply the profile recorded in the resumed session) or "last" (also
 * fall back to the profile file's `last`, the pre-0.2 behavior).
 */
type StartupMode = "default" | "session" | "last";

/** `launchPicker.startup` setting; defaults to "default". */
function readStartupMode(pi: ExtensionAPI): StartupMode {
	// SAFETY: settings are plain JSON merged from settings files. `launchPicker` is
	// this extension's own namespace — pi validates none of these keys, so nothing
	// in the Settings type describes it and only the JSON we read here can be there.
	const settings = pi.getSettings() as unknown as { launchPicker?: { startup?: unknown } };
	const raw = settings.launchPicker?.startup;
	return raw === "session" || raw === "last" ? raw : "default";
}

class MultiSelect implements Component {
	private cursor = 0;
	private scrollTop = 0;
	private visibleRows = 12;
	private title: string;
	private names: string[];
	private selected: Set<string>;
	private theme: Theme;
	private resolve: (result: string[] | null) => void;

	constructor(
		title: string,
		names: string[],
		selected: Set<string>,
		theme: Theme,
		resolve: (result: string[] | null) => void,
	) {
		this.title = title;
		this.names = names;
		this.selected = selected;
		this.theme = theme;
		this.resolve = resolve;
	}

	render(_width: number): string[] {
		const lines: string[] = [];
		lines.push(this.theme.fg("accent", this.theme.bold(this.title)));
		const total = this.names.length;
		this.visibleRows = Math.max(1, Math.min(total, 14));
		if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
		if (this.cursor >= this.scrollTop + this.visibleRows) this.scrollTop = this.cursor + 1 - this.visibleRows;
		const visible = this.names.slice(this.scrollTop, this.scrollTop + this.visibleRows);
		const cursorOffset = this.cursor - this.scrollTop;
		for (let i = 0; i < visible.length; i++) {
			const name = visible[i];
			const box = this.selected.has(name) ? "x" : " ";
			const marker = i === cursorOffset ? ">" : " ";
			lines.push(`${this.theme.fg("muted", `${marker}[${box}]`)} ${name}`);
		}
		if (total > this.visibleRows) {
			lines.push(this.theme.fg("dim", `  ${this.scrollTop + 1}-${Math.min(this.scrollTop + this.visibleRows, total)} of ${total}`));
		}
		lines.push(this.theme.fg("muted", `${this.selected.size} selected`));
		return lines;
	}

	handleInput(data: string): void {
		const total = this.names.length;
		if (matchesKey(data, Key.enter)) {
			this.resolve([...this.selected]);
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.resolve(null);
			return;
		}
		if (total === 0) return;
		if (matchesKey(data, Key.up)) {
			this.cursor = (this.cursor - 1 + total) % total;
		} else if (matchesKey(data, Key.down)) {
			this.cursor = (this.cursor + 1) % total;
		} else if (matchesKey(data, Key.space)) {
			const name = this.names[this.cursor];
			if (this.selected.has(name)) this.selected.delete(name);
			else this.selected.add(name);
		}
	}

	invalidate(): void {}
}

export default function launchPickerExtension(pi: ExtensionAPI) {
	let profiles: ProfilesFile = { profiles: {} };
	let prompts: Record<string, string> = {};
	let activeProfile: string | undefined;
	/** undefined = built-in prompt, "" = empty, otherwise a preset name. */
	let activePrompt: string | undefined;
	/** undefined = every skill advertised, otherwise the allowlist. */
	let activeSkills: string[] | undefined;
	/** undefined = every plugin contributes, otherwise the allowlist. */
	let activePlugins: string[] | undefined;
	let initialTools: string[] | undefined;

	function loadProfiles(): ProfilesFile {
		try {
			if (existsSync(PROFILES_FILE)) {
				const parsed = JSON.parse(readFileSync(PROFILES_FILE, "utf-8")) as ProfilesFile;
				if (parsed && typeof parsed === "object" && parsed.profiles) return parsed;
			}
		} catch {
			// fall through to empty
		}
		return { profiles: {} };
	}

	function saveProfiles(): void {
		try {
			writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, "\t") + "\n");
		} catch (err) {
			console.error(`launch-picker: failed to save profiles: ${err}`);
		}
	}

	function loadPrompts(): Record<string, string> {
		const out: Record<string, string> = {};
		if (!existsSync(PROMPTS_DIR)) return out;
		for (const file of readdirSync(PROMPTS_DIR)) {
			if (!file.endsWith(".md")) continue;
			try {
				out[file.slice(0, -3)] = readFileSync(join(PROMPTS_DIR, file), "utf-8");
			} catch {
				// skip unreadable file
			}
		}
		return out;
	}

	function visibleTools(): string[] {
		return pi.getAllTools().filter((t) => t.exposure !== "hidden").map((t) => t.name);
	}

	function isPackageSource(source: string): boolean {
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	/**
	 * Stable plugin id for a resource: `builtin:<name>`, `npm:<pkg>`, `git:<host>/<path>`,
	 * `<inline:...>`, or the file stem of a top-level extension file. Core built-in tools
	 * return undefined because no plugin owns them.
	 */
	function pluginId(info: SourceInfo): string | undefined {
		const { path, source } = info;
		if (path.startsWith("<")) return path;
		if (path.startsWith("builtin:")) return CORE_TOOL_PATHS.has(path) ? undefined : path;
		if (isPackageSource(source)) return source;
		const segments = path.split("/");
		const stem = (segments.pop() ?? "").replace(/\.(ts|js|mjs|cjs)$/i, "");
		if (stem !== "index" && stem !== "") return stem;
		let dir = segments.pop();
		if (dir === "src" || dir === "dist" || dir === "lib" || dir === "build") dir = segments.pop();
		return dir || path;
	}

	function shortPluginName(id: string): string {
		if (id.startsWith("git:")) {
			const repo = id.slice("git:".length).split("/").pop() ?? id;
			return repo.split("@")[0] || repo;
		}
		if (id.startsWith("npm:")) return id.slice("npm:".length);
		if (id.startsWith("builtin:")) return id.slice("builtin:".length);
		return id;
	}

	function pluginMatches(id: string, wanted: string): boolean {
		return id === wanted || shortPluginName(id) === shortPluginName(wanted);
	}

	function pluginSelected(id: string): boolean {
		return activePlugins === undefined || activePlugins.some((wanted) => pluginMatches(id, wanted));
	}

	/** Every plugin visible in this session: tool owners plus command/skill/prompt owners. */
	function pluginChoices(): string[] {
		const ids = new Set<string>();
		for (const tool of pi.getAllTools()) {
			const id = pluginId(tool.sourceInfo);
			if (id) ids.add(id);
		}
		for (const command of pi.getCommands()) {
			if (command.source === "extension") {
				const id = pluginId(command.sourceInfo);
				if (id) ids.add(id);
			} else if (isPackageSource(command.sourceInfo.source)) {
				ids.add(command.sourceInfo.source);
			}
		}
		return [...ids].sort();
	}

	function toolAllowedBy(plugins: string[] | undefined, name: string): boolean {
		const info = pi.getAllTools().find((tool) => tool.name === name);
		if (!info) return false;
		if (CORE_TOOL_PATHS.has(info.sourceInfo.path)) return true;
		const id = pluginId(info.sourceInfo);
		return id === undefined || plugins === undefined || plugins.some((wanted) => pluginMatches(id, wanted));
	}

	function toolAllowed(name: string): boolean {
		return toolAllowedBy(activePlugins, name);
	}

	/**
	 * Resolve a tool list into the set to activate: absolute lists replace the
	 * active set, delta lists add to / remove from it. Returns null when the list
	 * is rejected, in which case nothing changed.
	 */
	function resolveTools(spec: ListSpec, ctx: ExtensionContext, label?: string): string[] | null {
		const at = label ? `${label}: ` : "";
		if (spec.mode === "delta" && spec.plain.length > 0) {
			ctx.ui.notify(`${at}cannot mix plain names with +/- entries — ${spec.plain.join(", ")}`, "error");
			return null;
		}
		const all = visibleTools();
		const known = new Set(all);
		const adds = spec.mode === "absolute" ? spec.plain : spec.add;
		const unknown = [...adds, ...spec.remove].filter((name) => !known.has(name));
		const blocked = adds.filter((name) => known.has(name) && !toolAllowed(name));
		if (unknown.length > 0) {
			ctx.ui.notify(`${at}unknown tools: ${unknown.join(", ")}`, "warning");
		}
		if (blocked.length > 0) {
			ctx.ui.notify(`${at}tools from disabled plugins skipped: ${blocked.join(", ")} — see /lplugins`, "warning");
		}
		if (spec.mode === "absolute") return adds.filter((name) => known.has(name) && toolAllowed(name));
		const next = new Set(pi.getActiveTools());
		for (const name of adds) {
			if (known.has(name) && toolAllowed(name)) next.add(name);
		}
		for (const name of spec.remove) next.delete(name);
		return all.filter((name) => next.has(name));
	}

	/** Skills as pi sees them, reconstructed from slash-command metadata. */
	function availableSkills(): Skill[] {
		const seen = new Map<string, Skill>();
		for (const command of pi.getCommands()) {
			if (command.source !== "skill") continue;
			const name = command.name.replace(/^skill:/, "");
			if (seen.has(name)) continue;
			let disableModelInvocation = false;
			try {
				const text = readFileSync(command.sourceInfo.path, "utf-8");
				const end = text.indexOf("\n---", 3);
				const frontmatter = text.startsWith("---") && end > 0 ? text.slice(3, end) : "";
				disableModelInvocation = /^\s*disable-model-invocation:\s*true\s*$/m.test(frontmatter);
			} catch {
				// unreadable skill file: treat as advertised, like pi does
			}
			seen.set(name, {
				name,
				description: command.description ?? "",
				filePath: command.sourceInfo.path,
				baseDir: command.sourceInfo.baseDir ?? join(command.sourceInfo.path, ".."),
				sourceInfo: command.sourceInfo,
				disableModelInvocation,
			});
		}
		return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	function skillPluginEnabled(sourceInfo: SourceInfo): boolean {
		return !isPackageSource(sourceInfo.source) || pluginSelected(sourceInfo.source);
	}

	function skillAllowed(name: string, sourceInfo: SourceInfo): boolean {
		if (!skillPluginEnabled(sourceInfo)) return false;
		return activeSkills === undefined || activeSkills.includes(name);
	}

	/** Skills block re-attached to a custom prompt preset, mirroring pi's reader rule. */
	function promptSkillsBlock(tools: string[]): string {
		if (activeSkills === undefined) return "";
		const reader = tools.includes("read") ? "read" : tools.includes("bash") ? "bash" : undefined;
		if (!reader) return "";
		const skills = availableSkills().filter((skill) => skillAllowed(skill.name, skill.sourceInfo));
		return formatSkillsForPrompt(skills, reader).trim();
	}

	function promptChoices(): string[] {
		return [DEFAULT_PROMPT, EMPTY_PROMPT, ...Object.keys(prompts).sort()];
	}

	function effectiveSkillCount(): number {
		const sources = new Map<string, SourceInfo>();
		for (const command of pi.getCommands()) {
			if (command.source === "skill") sources.set(command.name.replace(/^skill:/, ""), command.sourceInfo);
		}
		return (activeSkills ?? []).filter((name) => {
			const info = sources.get(name);
			return info === undefined || skillPluginEnabled(info);
		}).length;
	}

	function updateStatus(ctx: ExtensionContext): void {
		const parts: string[] = [];
		if (activeProfile) parts.push(`profile:${activeProfile}`);
		if (activePrompt === "") parts.push("prompt:(empty)");
		else if (activePrompt) parts.push(`prompt:${activePrompt}`);
		if (activeSkills !== undefined) {
			const total = activeSkills.length;
			const effective = effectiveSkillCount();
			parts.push(total === 0 ? "skills:none" : effective === total ? `skills:${total}` : `skills:${effective}/${total}`);
		}
		if (activePlugins !== undefined) parts.push(activePlugins.length === 0 ? "plugins:none" : `plugins:${activePlugins.length}`);
		if (parts.length > 0) ctx.ui.setStatus("launch-picker", ctx.ui.theme.fg("accent", parts.join(" ")));
		else ctx.ui.setStatus("launch-picker", undefined);
	}

	async function applyPrompt(name: string, ctx: ExtensionContext): Promise<boolean> {
		if (name === DEFAULT_PROMPT) {
			activePrompt = undefined;
		} else if (name === EMPTY_PROMPT) {
			activePrompt = "";
		} else if (prompts[name] !== undefined) {
			activePrompt = name;
		} else {
			ctx.ui.notify(`Unknown prompt preset "${name}". Available: ${promptChoices().join(", ")}`, "error");
			return false;
		}
		updateStatus(ctx);
		return true;
	}

	async function applyPlugins(spec: ListSpec | undefined, ctx: ExtensionContext): Promise<boolean> {
		if (spec === undefined) {
			activePlugins = undefined;
		} else {
			if (spec.mode === "delta" && spec.plain.length > 0) {
				ctx.ui.notify(`cannot mix plain plugin names with +/- entries — ${spec.plain.join(", ")}`, "error");
				return false;
			}
			const available = pluginChoices();
			const canonical = (wanted: string): string | undefined => available.find((id) => pluginMatches(id, wanted));
			const adds = spec.mode === "absolute" ? spec.plain : spec.add;
			const unknown = [...adds, ...spec.remove].filter((wanted) => canonical(wanted) === undefined);
			if (unknown.length > 0) {
				ctx.ui.notify(`Unknown plugins: ${unknown.join(", ")}. Known: ${available.join(", ") || "(none)"}`, "warning");
			}
			if (spec.mode === "absolute") {
				const valid = adds.filter((wanted) => canonical(wanted) !== undefined);
				// A typo must not silently strip every plugin-owned tool from the session.
				if (adds.length > 0 && valid.length === 0) {
					ctx.ui.notify("No plugin matched — extension allowlist unchanged", "error");
					return false;
				}
				activePlugins = valid;
			} else {
				const selected = new Set(
					activePlugins === undefined
						? available
						: available.filter((id) => activePlugins?.some((wanted) => pluginMatches(id, wanted))),
				);
				for (const wanted of spec.add) {
					const id = canonical(wanted);
					if (id !== undefined) selected.add(id);
				}
				for (const wanted of spec.remove) {
					for (const id of [...selected]) if (pluginMatches(id, wanted)) selected.delete(id);
				}
				activePlugins = selected.size === available.length ? undefined : available.filter((id) => selected.has(id));
			}
		}
		const before = pi.getActiveTools();
		const kept = before.filter((name) => toolAllowed(name));
		if (kept.length !== before.length) pi.setActiveTools(kept);
		updateStatus(ctx);
		return true;
	}

	async function applySkills(spec: ListSpec | undefined, ctx: ExtensionContext): Promise<boolean> {
		if (spec === undefined) {
			activeSkills = undefined;
		} else {
			if (spec.mode === "delta" && spec.plain.length > 0) {
				ctx.ui.notify(`cannot mix plain skill names with +/- entries — ${spec.plain.join(", ")}`, "error");
				return false;
			}
			const available = availableSkills();
			const known = new Set(available.map((skill) => skill.name));
			const adds = spec.mode === "absolute" ? spec.plain : spec.add;
			const unknown = [...adds, ...spec.remove].filter((name) => !known.has(name));
			const blocked = adds.filter((name) => {
				const skill = available.find((candidate) => candidate.name === name);
				return skill !== undefined && !skillPluginEnabled(skill.sourceInfo);
			});
			if (unknown.length > 0) {
				ctx.ui.notify(`Unknown skills: ${unknown.join(", ")}`, "warning");
			}
			if (blocked.length > 0) {
				ctx.ui.notify(`Skills from disabled plugins skipped: ${blocked.join(", ")} — see /lplugins`, "warning");
			}
			if (spec.mode === "absolute") {
				activeSkills = adds.filter((name) => known.has(name));
			} else {
				const selected = new Set((activeSkills ?? [...known]).filter((name) => known.has(name)));
				for (const name of spec.add) if (known.has(name)) selected.add(name);
				for (const name of spec.remove) selected.delete(name);
				activeSkills = selected.size === known.size ? undefined : [...selected].sort();
			}
		}
		updateStatus(ctx);
		return true;
	}

	async function applyProfile(name: string, ctx: ExtensionContext): Promise<boolean> {
		const profile = profiles.profiles[name];
		if (!profile) {
			const available = Object.keys(profiles.profiles).join(", ") || "(none defined)";
			ctx.ui.notify(`Unknown profile "${name}". Available: ${available}`, "error");
			return false;
		}
		const specs = {
			extensions: profile.extensions === undefined ? undefined : parseList(profile.extensions),
			tools: profile.tools === undefined ? undefined : parseList(profile.tools),
			skills: profile.skills === undefined ? undefined : parseList(profile.skills),
		};
		// One list cannot be both absolute and relative. Reject the whole profile up
		// front so a half-applied state is never left behind.
		const mixed = Object.entries(specs).filter(
			([, spec]) => spec !== undefined && spec.mode === "delta" && spec.plain.length > 0,
		);
		if (mixed.length > 0) {
			const detail = mixed.map(([field, spec]) => `${field} (${spec?.plain.join(", ")})`).join("; ");
			ctx.ui.notify(
				`Profile "${name}" not applied: a list cannot mix plain names with +/- entries — ${detail}`,
				"error",
			);
			return false;
		}
		if (specs.extensions !== undefined && !(await applyPlugins(specs.extensions, ctx))) {
			ctx.ui.notify(`Profile "${name}" not applied`, "error");
			return false;
		}
		// Tools resolve after extensions: the plugin allowlist decides which names exist.
		if (specs.tools !== undefined) {
			const tools = resolveTools(specs.tools, ctx, `Profile "${name}"`);
			if (tools === null) {
				ctx.ui.notify(`Profile "${name}" not applied`, "error");
				return false;
			}
			pi.setActiveTools(tools);
		}
		if (specs.skills !== undefined) {
			await applySkills(specs.skills, ctx);
		}
		if (profile.prompt !== undefined) {
			await applyPrompt(profile.prompt, ctx);
		}
		activeProfile = name;
		profiles.last = name;
		saveProfiles();
		updateStatus(ctx);
		return true;
	}

	async function clearAll(ctx: ExtensionContext): Promise<void> {
		activeProfile = undefined;
		activePrompt = undefined;
		activeSkills = undefined;
		activePlugins = undefined;
		if (initialTools) pi.setActiveTools(initialTools);
		profiles.last = undefined;
		saveProfiles();
		updateStatus(ctx);
	}

	async function pickMany(
		ctx: ExtensionContext,
		title: string,
		names: string[],
		selected: Set<string>,
	): Promise<string[] | null> {
		return ctx.ui.custom<string[] | null>((_tui, theme, _kb, done) =>
			new MultiSelect(title, names, selected, theme, (result) => done(result)),
		);
	}

	async function runCustomFlow(ctx: ExtensionContext): Promise<void> {
		const tools = await pickMany(ctx, TOOLS_TITLE, visibleTools(), new Set(pi.getActiveTools()));
		if (tools === null) {
			ctx.ui.notify("Custom profile cancelled", "info");
			return;
		}
		const pluginNames = pluginChoices();
		const plugins = await pickMany(ctx, PLUGINS_TITLE, pluginNames, new Set(activePlugins ?? pluginNames));
		if (plugins === null) {
			ctx.ui.notify("Custom profile cancelled", "info");
			return;
		}
		const pluginFilter = plugins.length === pluginNames.length ? undefined : plugins;
		const allowedTools = tools.filter((name) => toolAllowedBy(pluginFilter, name));
		if (allowedTools.length !== tools.length) {
			ctx.ui.notify(`Tools from unchecked plugins dropped: ${tools.filter((name) => !allowedTools.includes(name)).join(", ")}`, "warning");
		}
		const skillNames = availableSkills().map((skill) => skill.name);
		const skills = await pickMany(ctx, SKILLS_TITLE, skillNames, new Set(activeSkills ?? skillNames));
		if (skills === null) {
			ctx.ui.notify("Custom profile cancelled", "info");
			return;
		}
		const promptChoice = await ctx.ui.select("System prompt preset", promptChoices());
		if (!promptChoice) return;
		const rawName = await ctx.ui.input("Profile name", "e.g. research");
		if (!rawName || !rawName.trim()) return;
		const name = rawName.trim();
		profiles = loadProfiles();
		profiles.profiles[name] = {
			tools: allowedTools,
			prompt: promptChoice,
			...(pluginFilter === undefined ? {} : { extensions: pluginFilter }),
			...(skills.length === skillNames.length ? {} : { skills }),
		};
		profiles.last = name;
		saveProfiles();
		await applyProfile(name, ctx);
		ctx.ui.notify(`Profile "${name}" saved and applied`, "info");
	}

	async function runPicker(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		profiles = loadProfiles();
		prompts = loadPrompts();
		const options = [
			...Object.keys(profiles.profiles).sort(),
			NONE_CHOICE,
			...(ctx.mode === "tui" ? [CUSTOM_CHOICE] : []),
		];
		const choice = await ctx.ui.select("Launch profile", options);
		if (!choice) return;
		if (choice === NONE_CHOICE) {
			await clearAll(ctx);
			ctx.ui.notify("Launch configuration cleared: default prompt, all tools, skills and plugins", "info");
			return;
		}
		if (choice === CUSTOM_CHOICE) {
			await runCustomFlow(ctx);
			return;
		}
		if (await applyProfile(choice, ctx)) {
			ctx.ui.notify(`Profile "${choice}" applied`, "info");
		}
	}

	// Replace the whole system prompt for each turn while a preset is active, and
	// narrow the skills block to the profile's allowlist in every prompt mode.
	pi.on("before_agent_start", async (event) => {
		if (activeSkills !== undefined || activePlugins !== undefined) {
			event.systemPromptOptions.skills = event.systemPromptOptions.skills.filter((skill) =>
				skillAllowed(skill.name, skill.sourceInfo),
			);
		}
		if (activePrompt === undefined) return;
		const text = activePrompt === "" ? "" : (prompts[activePrompt] ?? "");
		// A preset replaces pi's own prompt (and its skills block), so put the allowed
		// skills back. "(empty)" stays truly empty.
		if (activeSkills === undefined || activePrompt === "") return { systemPrompt: text };
		const block = promptSkillsBlock(pi.getActiveTools());
		return { systemPrompt: block ? (text ? `${text}\n\n${block}` : block) : text };
	});

	// Skill commands and prompt templates expand after this hook, so a disabled
	// plugin's packaged ones can still be blocked. Extension commands run before it
	// and stay available — plugins cannot be unloaded at runtime.
	pi.on("input", async (event, ctx) => {
		const text = event.text.trimStart();
		if (!text.startsWith("/")) return;
		const head = text.slice(1).split(/\s+/, 1)[0] ?? "";
		if (!head) return;
		const command = pi.getCommands().find((candidate) => candidate.name === head);
		if (!command || (command.source !== "skill" && command.source !== "prompt")) return;
		const owner = command.sourceInfo.source;
		if (!isPackageSource(owner) || pluginSelected(owner)) return;
		ctx.ui.notify(
			`/${head} belongs to the disabled plugin "${owner}". Enable it in the profile (/lplugins) to use it.`,
			"warning",
		);
		return { action: "handled" };
	});

	pi.on("session_start", async (event, ctx) => {
		profiles = loadProfiles();
		prompts = loadPrompts();
		// Snapshot pi's own starting state once per process: the configured default
		// tool selection (`defaultTools`, e.g. read/bash/edit/write + codemode) and the
		// built-in prompt. That snapshot IS "the defaults" we reset to below.
		if (initialTools === undefined) initialTools = pi.getActiveTools();

		// Reset to defaults first. A profile saved in an earlier session must never
		// leak into this one implicitly — otherwise a stale profile (for example one
		// with an empty tool list and an empty prompt) leaves the app with nothing
		// but `codemode` and no system prompt. `/reload` keeps the in-session choice.
		if (event.reason !== "reload") {
			activeProfile = undefined;
			activePrompt = undefined;
			activeSkills = undefined;
			activePlugins = undefined;
			if (initialTools) pi.setActiveTools([...initialTools]);
		}

		const flag = pi.getFlag("lp-profile");
		if (typeof flag === "string" && flag) {
			if (profiles.profiles[flag]) {
				await applyProfile(flag, ctx);
				ctx.ui.notify(`Profile "${flag}" applied (--lp-profile)`, "info");
			} else {
				ctx.ui.notify(`--lp-profile: unknown profile "${flag}"`, "error");
			}
			updateStatus(ctx);
			return;
		}

		const startup = readStartupMode(pi);
		if (startup === "default") {
			// Explicit opt-in only: --lp-profile, /lprofile, /lpick, ctrl+shift+l.
			updateStatus(ctx);
			return;
		}

		const entries = ctx.sessionManager
			.getEntries()
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "launch-state") as Array<{
			data?: { profile?: string };
		}>;
		const entryProfile = entries.pop()?.data?.profile;

		if (entryProfile && profiles.profiles[entryProfile]) {
			await applyProfile(entryProfile, ctx);
		} else if (startup === "last" && profiles.last && profiles.profiles[profiles.last]) {
			await applyProfile(profiles.last, ctx);
		} else if (event.reason === "startup" && ctx.mode === "tui") {
			await runPicker(ctx);
		}
		updateStatus(ctx);
	});

	pi.on("turn_start", async () => {
		if (activeProfile) {
			pi.appendEntry("launch-state", { profile: activeProfile });
		}
	});

	pi.registerFlag("lp-profile", {
		description: "Launch profile to apply at startup",
		type: "string",
	});

	pi.registerShortcut(Key.ctrlShift("l"), {
		description: "Open launch picker",
		handler: async (ctx) => {
			await runPicker(ctx);
		},
	});

	pi.registerCommand("lpick", {
		description: "Open the launch picker (profile, tools, plugins, skills, system prompt)",
		handler: async (_args, ctx) => {
			await runPicker(ctx);
		},
	});

	pi.registerCommand("lprofile", {
		description: "Apply a launch profile: /lprofile <name>; no argument opens the picker; (none) clears",
		handler: async (args, ctx) => {
			profiles = loadProfiles();
			prompts = loadPrompts();
			const name = args?.trim();
			if (!name) {
				await runPicker(ctx);
				return;
			}
			if (name === NONE_CHOICE) {
				await clearAll(ctx);
				ctx.ui.notify("Launch configuration cleared", "info");
			} else {
				await applyProfile(name, ctx);
			}
		},
	});

	pi.registerCommand("lprompt", {
		description: `Set the system prompt preset: /lprompt <name> ("${DEFAULT_PROMPT}", "${EMPTY_PROMPT}", or a preset); no argument opens a selector`,
		handler: async (args, ctx) => {
			prompts = loadPrompts();
			const name = args?.trim();
			if (!name) {
				const choice = await ctx.ui.select("System prompt preset", promptChoices());
				if (choice) await applyPrompt(choice, ctx);
				return;
			}
			await applyPrompt(name, ctx);
		},
	});

	pi.registerCommand("ltools", {
		description: 'Set active tools: /ltools all | none | <tool1,tool2,...>; "+name" / "-name" add to or remove from the current set',
		handler: async (args, ctx) => {
			const spec = args?.trim();
			if (!spec) {
				ctx.ui.notify('Usage: /ltools all | none | read,bash,edit | +todo,-bash', "warning");
				return;
			}
			const all = visibleTools();
			if (spec === "all") {
				pi.setActiveTools(all.filter((name) => toolAllowed(name)));
			} else if (spec === "none") {
				pi.setActiveTools([]);
			} else {
				const resolved = resolveTools(
					parseList(
						spec
							.split(",")
							.map((s) => s.trim()),
					),
					ctx,
				);
				if (resolved === null) return;
				pi.setActiveTools(resolved);
			}
			activeProfile = undefined;
			updateStatus(ctx);
			ctx.ui.notify(`Active tools: ${pi.getActiveTools().join(", ") || "(none)"}`, "info");
		},
	});

	pi.registerCommand("lskills", {
		description:
			'Set the skill allowlist: /lskills all | none | <skill1,skill2,...>; "+name" / "-name" add or remove entries; no argument opens a selector',
		handler: async (args, ctx) => {
			const spec = args?.trim();
			if (!spec) {
				const names = availableSkills().map((skill) => skill.name);
				if (ctx.mode !== "tui") {
					const current = activeSkills === undefined ? `all (${names.join(", ") || "none"})` : activeSkills.join(", ") || "(none)";
					ctx.ui.notify(`Skills: ${current}. Usage: /lskills all | none | <skill1,skill2,...> | +docx,-pdf`, "info");
					return;
				}
				const selected = await pickMany(
					ctx,
					SKILLS_TITLE,
					names,
					new Set(activeSkills === undefined ? names : names.filter((name) => activeSkills?.includes(name))),
				);
				if (selected === null) return;
				await applySkills(selected.length === names.length ? undefined : parseList(selected), ctx);
			} else if (spec === "all") {
				await applySkills(undefined, ctx);
			} else if (spec === "none") {
				await applySkills(parseList([]), ctx);
			} else {
				await applySkills(
					parseList(
						spec
							.split(",")
							.map((s) => s.trim()),
					),
					ctx,
				);
			}
			activeProfile = undefined;
			updateStatus(ctx);
			const current = activeSkills === undefined ? "all" : activeSkills.join(", ") || "(none)";
			ctx.ui.notify(`Skills advertised: ${current}`, "info");
		},
	});

	pi.registerCommand("lplugins", {
		description:
			'Set the extension allowlist: /lplugins all | none | <id1,id2,...>; "+name" / "-name" add or remove entries; disabled plugins lose their tools, packaged skills and prompt templates',
		handler: async (args, ctx) => {
			const spec = args?.trim();
			if (!spec) {
				const available = pluginChoices();
				if (ctx.mode !== "tui") {
					const current =
						activePlugins === undefined
							? `all (${available.join(", ") || "none"})`
							: available.filter((id) => activePlugins?.some((wanted) => pluginMatches(id, wanted))).join(", ") || "(none)";
					ctx.ui.notify(`Plugins: ${current}. Usage: /lplugins all | none | <id1,id2,...> | +pi-todo,-pi-lens`, "info");
					return;
				}
				const selected = await pickMany(
					ctx,
					PLUGINS_TITLE,
					available,
					new Set(
						activePlugins === undefined
							? available
							: available.filter((id) => activePlugins?.some((wanted) => pluginMatches(id, wanted))),
					),
				);
				if (selected === null) return;
				await applyPlugins(selected.length === available.length ? undefined : parseList(selected), ctx);
			} else if (spec === "all") {
				await applyPlugins(undefined, ctx);
			} else if (spec === "none") {
				await applyPlugins(parseList([]), ctx);
			} else {
				await applyPlugins(
					parseList(
						spec
							.split(",")
							.map((s) => s.trim()),
					),
					ctx,
				);
			}
			activeProfile = undefined;
			updateStatus(ctx);
			const all = pluginChoices();
			const current =
				activePlugins === undefined
					? "all"
					: all.filter((id) => activePlugins?.some((wanted) => pluginMatches(id, wanted))).join(", ") || "(none)";
			ctx.ui.notify(`Plugins allowed: ${current}`, "info");
		},
	});

	function effectivePrompt(ctx: ExtensionContext): string {
		if (activePrompt === undefined) return ctx.getSystemPrompt();
		if (activePrompt === "") return "";
		const text = prompts[activePrompt] ?? "";
		const block = promptSkillsBlock(pi.getActiveTools());
		if (!block) return text;
		return text ? `${text}\n\n${block}` : block;
	}

	function stateSummary(ctx: ExtensionContext): string {
		const active = pi.getActiveTools();
		const total = pi.getAllTools().filter((t) => t.exposure !== "hidden").length;
		const toolList =
			active.length > 15 ? `${active.slice(0, 15).join(", ")} (+${active.length - 15} more)` : active.join(", ") || "(none)";

		const allSkills = availableSkills();
		const allowedSkills = allSkills.filter((skill) => skillAllowed(skill.name, skill.sourceInfo));
		const hiddenFromPrompt = new Set(allSkills.filter((skill) => skill.disableModelInvocation).map((skill) => skill.name));

		const promptName = activePrompt === undefined ? "(default)" : activePrompt === "" ? "(empty)" : activePrompt;
		const promptLen = effectivePrompt(ctx).length;
		const inPrompt = allowedSkills.filter((skill) => !hiddenFromPrompt.has(skill.name)).map((skill) => skill.name);
		// pi injects the skills block only when read or bash is active (the model needs a way to open SKILL.md).
		const skillsSent = ["read", "bash"].some((tool) => active.includes(tool));
		const filteredOut = allSkills.length - allowedSkills.length;
		const skillLine =
			allowedSkills.length === 0
				? `skills: (none${filteredOut > 0 ? `, ${filteredOut} filtered out by profile` : ""})`
				: `skills: ${skillsSent ? inPrompt.length : 0}/${allowedSkills.length} in prompt — ${allowedSkills
						.map((skill) => skill.name)
						.join(", ")}${skillsSent ? "" : " (not sent: no read/bash tool active)"}${
						skillsSent && hiddenFromPrompt.size > 0
							? ` (hidden from prompt: ${[...hiddenFromPrompt].sort().join(", ")})`
							: ""
					}${filteredOut > 0 ? ` (${filteredOut} filtered out by profile)` : ""}`;

		const allPlugins = pluginChoices();
		const allowedPlugins =
			activePlugins === undefined
				? allPlugins
				: allPlugins.filter((id) => activePlugins?.some((wanted) => pluginMatches(id, wanted)));
		const pluginLine =
			activePlugins === undefined
				? `plugins: all (${allPlugins.length}) — ${allPlugins.join(", ") || "(none)"}`
				: `plugins: ${allowedPlugins.length}/${allPlugins.length} allowed — ${allowedPlugins.join(", ") || "(none)"}`;

		return [
			"Session state",
			`tools: ${active.length}/${total} — ${toolList}`,
			`prompt: ${promptName} — ${promptLen} chars`,
			skillLine,
			pluginLine,
			`profile: ${activeProfile ?? "(none)"}  last: ${profiles.last ?? "(none)"}`,
		].join("\n");
	}

	pi.registerCommand("lstate", {
		description: "Show session state: tools, skills, plugins, system prompt (argument 'prompt' dumps the full prompt)",
		handler: async (args, ctx) => {
			profiles = loadProfiles();
			prompts = loadPrompts();
			if (args?.trim() === "prompt") {
				const sys = effectivePrompt(ctx);
				const cap = 4000;
				ctx.ui.notify(`System prompt (${sys.length} chars):\n${sys.length > cap ? `${sys.slice(0, cap)} …[truncated]` : sys}`, "info");
			} else {
				ctx.ui.notify(stateSummary(ctx), "info");
			}
		},
	});

	pi.registerCommand("lsave", {
		description: "Save the current tools, system prompt, skills and plugins as a named profile",
		handler: async (args, ctx) => {
			const name = args?.trim();
			if (!name) {
				ctx.ui.notify("Usage: /lsave <name>", "warning");
				return;
			}
			profiles = loadProfiles();
			const prompt = activePrompt === undefined ? DEFAULT_PROMPT : activePrompt === "" ? EMPTY_PROMPT : activePrompt;
			profiles.profiles[name] = {
				tools: pi.getActiveTools(),
				prompt,
				...(activeSkills === undefined ? {} : { skills: activeSkills }),
				...(activePlugins === undefined ? {} : { extensions: activePlugins }),
			};
			profiles.last = name;
			activeProfile = name;
			saveProfiles();
			updateStatus(ctx);
			ctx.ui.notify(`Profile "${name}" saved`, "info");
		},
	});
}
