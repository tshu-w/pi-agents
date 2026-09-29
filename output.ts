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
