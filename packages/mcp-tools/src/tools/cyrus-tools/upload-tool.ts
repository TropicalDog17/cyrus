import { basename } from "node:path";
import type { LinearClient } from "@linear/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs-extra";
import { z } from "zod";
import { getMimeType } from "./mime-types.js";

export function registerUploadTool(
	server: McpServer,
	linearClient: LinearClient,
): void {
	server.registerTool(
		"linear_upload_file",
		{
			description:
				"Upload a file to Linear. Returns an asset URL that can be used in issue descriptions or comments.",
			inputSchema: {
				filePath: z
					.string()
					.describe("The absolute path to the file to upload"),
				filename: z
					.string()
					.optional()
					.describe(
						"The filename to use in Linear (optional, defaults to basename of filePath)",
					),
				contentType: z
					.string()
					.optional()
					.describe(
						"MIME type of the file (optional, auto-detected if not provided)",
					),
				makePublic: z
					.boolean()
					.optional()
					.describe(
						"Whether to make the file publicly accessible (default: false)",
					),
			},
		},
		async ({ filePath, filename, contentType, makePublic }) => {
			try {
				const stats = await fs.stat(filePath);
				if (!stats.isFile()) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: `Path ${filePath} is not a file`,
								}),
							},
						],
					};
				}

				const fileBuffer = await fs.readFile(filePath);
				const finalFilename = filename || basename(filePath);
				const finalContentType = contentType || getMimeType(finalFilename);
				const size = stats.size;

				const uploadPayload = await linearClient.fileUpload(
					finalContentType,
					finalFilename,
					size,
					{ makePublic },
				);

				if (!uploadPayload.success || !uploadPayload.uploadFile) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: "Failed to get upload URL from Linear",
								}),
							},
						],
					};
				}

				const { uploadUrl, headers, assetUrl } = uploadPayload.uploadFile;
				const uploadHeaders: Record<string, string> = {
					"Content-Type": finalContentType,
					"Cache-Control": "public, max-age=31536000",
				};

				for (const header of headers) {
					uploadHeaders[header.key] = header.value;
				}

				const uploadResponse = await fetch(uploadUrl, {
					method: "PUT",
					headers: uploadHeaders,
					body: fileBuffer,
				});

				if (!uploadResponse.ok) {
					const errorText = await uploadResponse.text();
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: `Failed to upload file: ${uploadResponse.status} ${uploadResponse.statusText} - ${errorText}`,
								}),
							},
						],
					};
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								assetUrl,
								filename: finalFilename,
								size,
								contentType: finalContentType,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	);
}
