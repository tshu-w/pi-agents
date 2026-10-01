export function rejectFields(params: Record<string, unknown>, action: string, fields: string[]): void {
	const present = fields.filter((field) => params[field] !== undefined);
	if (present.length > 0) throw new Error(`${action} does not accept: ${present.join(", ")}`);
}
