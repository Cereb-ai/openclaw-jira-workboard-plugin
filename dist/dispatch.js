export function textResult(data) {
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    return {
        content: [{ type: "text", text }],
        details: data,
    };
}
