import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";

export interface Truncation {
	truncation: TruncationResult;
	fullOutputPath: string;
}

export interface BoundedText {
	text: string;
	/** The kept prefix of the text, without the notice. */
	kept: string;
	details?: Truncation;
}

/** Apply Pi's output limits, saving the full text to a file named in the notice. */
export function boundText(text: string, prefix: string): BoundedText {
	const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncation.truncated) return { text, kept: text };
	const fullOutputPath = join(mkdtempSync(join(tmpdir(), `${prefix}-`)), "output.txt");
	writeFileSync(fullOutputPath, text, "utf8");
	const summary = truncation.firstLineExceedsLimit
		? `Line 1 is ${formatSize(Buffer.byteLength(text.split("\n")[0]!, "utf8"))}, exceeds ${formatSize(truncation.maxBytes)} limit.`
		: `Showing lines 1-${truncation.outputLines} of ${truncation.totalLines}${truncation.truncatedBy === "bytes" ? ` (${formatSize(truncation.maxBytes)} limit)` : ""}.`;
	return {
		text: `${truncation.content}\n\n[${summary} Full output: ${fullOutputPath}]`,
		kept: truncation.content,
		details: { truncation, fullOutputPath },
	};
}

/**
 * Bounds result blocks joined by blank lines. The block that crosses the limit keeps its closing
 * tag; `shown` counts the blocks that appear, and the caller names the omitted ones.
 */
export function boundBlocks(blocks: string[], tag: string, prefix: string): BoundedText & { shown: number } {
	const bounded = boundText(blocks.join("\n\n"), prefix);
	if (!bounded.details) return { ...bounded, shown: blocks.length };
	const kept = bounded.kept;
	let start = 0;
	const shown = blocks.filter((block) => {
		const visible = start < kept.length;
		start += block.length + 2;
		return visible;
	}).length;
	const open = kept.lastIndexOf(`<${tag} `) > kept.lastIndexOf(`</${tag}>`);
	return { ...bounded, text: `${kept}${open ? `\n</${tag}>` : ""}${bounded.text.slice(kept.length)}`, shown };
}
