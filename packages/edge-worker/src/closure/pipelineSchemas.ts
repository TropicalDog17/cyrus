import { z } from "zod";

export const PipelinePrFactSchema = z
	.object({
		run_id: z.string().min(1),
		issue_id: z.string().min(1),
		repo: z.string().min(1),
		repo_dir: z.string().min(1),
		number: z.number().int().positive(),
		head_sha: z.string().min(1),
		base: z.string().min(1),
		url: z.string().url().optional(),
		branch: z.string().min(1).optional(),
		created_at: z.string().optional(),
		captured_at: z.string().optional(),
	})
	.strict();

export const PipelineHumanFactSchema = z
	.object({
		verdict: z.enum(["approved", "rejected", "needs-rework"]),
		findings: z.array(
			z
				.object({
					text: z.string(),
					tag: z.enum(["recurring", "one-off"]),
					rule_ineffective: z.boolean().nullable().optional(),
				})
				.strict(),
		),
		head_sha: z.string().min(1).nullable(),
		recorded_at: z.string().optional(),
	})
	.strict();

export const PipelineMergeFactSchema = z
	.object({
		run_id: z.string().min(1),
		merged: z.literal(true),
		pr: z.number().int().positive(),
		method: z.enum(["squash", "merge", "rebase"]),
		merge_commit: z.string().nullable(),
		base: z.string().nullable().optional(),
		head_sha: z.string().min(1).nullable(),
		at: z.string().min(1),
	})
	.strict();

export const PipelineAbandonmentFactSchema = z
	.object({
		run_id: z.string().min(1),
		abandoned: z.literal(true),
		pr: z.number().int().positive(),
		repo: z.string().min(1),
		closed_at: z.string().nullable().optional(),
		source: z.literal("pr-watch"),
		at: z.string().min(1),
	})
	.strict();
export const PipelineWatchSchema = z
	.object({
		results: z.array(z.unknown()),
		liveness: z.record(z.string(), z.unknown()),
	})
	.passthrough();

export const PipelineReviewSchema = z
	.object({
		run_id: z.string().min(1),
		diff: z.string(),
		ledger: z.array(z.unknown()),
		diffscan_warnings: z.array(z.unknown()),
		note: z.string(),
	})
	.strict();

export const PipelineIntegrateResultSchema = z
	.object({
		run_id: z.string().min(1),
		integrated: z.boolean(),
		refused: z.boolean().optional(),
	})
	.passthrough();

export type PipelinePrFact = z.infer<typeof PipelinePrFactSchema>;
export type PipelineHumanFact = z.infer<typeof PipelineHumanFactSchema>;
export type PipelineMergeFact = z.infer<typeof PipelineMergeFactSchema>;
export type PipelineAbandonmentFact = z.infer<
	typeof PipelineAbandonmentFactSchema
>;
export type PipelineWatch = z.infer<typeof PipelineWatchSchema>;
export type PipelineReview = z.infer<typeof PipelineReviewSchema>;
export type PipelineIntegrateResult = z.infer<
	typeof PipelineIntegrateResultSchema
>;
