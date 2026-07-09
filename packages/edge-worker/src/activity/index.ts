/**
 * The activity module: the single per-tool render table (ActivityMapper), the
 * neutral Activity value it emits, the read-only MapContext snapshot it reads,
 * and the genuine content formatters kept from ActivityPoster.
 *
 * @module activity
 */

export type {
	Activity,
	ActivityModifiers,
	ActivityPostResult,
	ActivitySignal,
} from "./Activity.js";
export { ActivityMapper, normalizeTool } from "./ActivityMapper.js";
export {
	formatLabelRoleThought,
	formatRepoSetupHookActivity,
	formatRoutingThought,
} from "./formatters.js";
export type { MapContext } from "./MapContext.js";
