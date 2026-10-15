
// Decode actionable Google Flow errors. This module never retries requests.
const PROMPT_SAFETY_MARKERS = [
  "public_error_violence_filter",
  "public_error_danger_filter",
  "prompt_safety",
  "flow_safety",
  "sensitive words",
  "responsible ai practices",
];

const GENERATION_REJECTION_MARKERS = [
  "generation_rejected",
  // Observed in native Flow responses as google.rpc.ErrorInfo.reason.
  "public_error_unsafe_generation",
];

const PROMINENT_PERSON_MARKERS = [
  // Observed in video:batchCheckAsyncVideoGenerationStatus after Flow had
  // accepted the generation operation. The UI says that known-person
  // generation is disallowed and confirms that no credits were charged.
  "public_error_prominent_people_filter_failed",
  "prominent_person",
];

const DAILY_QUOTA_MARKERS = [
  "model_daily_quota_reached",
  "daily limit reached",
];

//: Observed live: a free Google account is refused both Veo models with
//: "The caller does not have permission" while image and speech on the same
//: account succeed. Auto Flow files the same thing under model_access_denied
//: and never retries it.
const ACCESS_DENIED_MARKERS = [
  "does not have permission",
  "permission_denied",
  "model_access_denied",
  "model access denied",
  "access_denied",
];

const CAPTCHA_REJECTION_MARKERS = ["recaptcha evaluation failed"];

const SESSION_HEAT_TEXT_MARKERS = ["public_error_unusual_activity"];

const ACCOUNT_THROTTLE_MARKERS = [
  "public_error_user_requests_throttled",
  "public_error_concurrent_limit_reached",
  "user_requests_throttled",
];

const CAPACITY_TEXT_MARKERS = [
  "public_error_high_traffic",
  "public_error_model_disabled_due_to_traffic",
  "public_error_model_overloaded",
  "high demand",
  "server busy",
  "try again later",
  "resource_exhausted",
  "resource exhausted",
];

const INVALID_ARGUMENT_MARKERS = [
  "invalid_argument",
  "request contains an invalid argument",
];

function includesAny(haystack: string, markers: readonly string[]) {
  return markers.some((marker) => haystack.includes(marker));
}

/**
 * @param {{status: number | null, rawText: string, generationFailed?: boolean}} input
 * @returns {{code: string, summary: string} | null}
 */
export function classifyFlowError({
  status,
  rawText,
  generationFailed = false,
}: {
  status?: number | null;
  rawText: string;
  generationFailed?: boolean;
}) {
  const text = String(rawText || "").toLowerCase();

  if (text.includes("public_error_non_english_prompt")) {
    return {
      code: "FLOW_NON_ENGLISH_PROMPT",

      summary: "Google Flow requires this visual prompt in English",
    };
  }
  // Repair the uploaded copy, never the scene prompt. These must win over
  // INVALID_ARGUMENT, which also wraps reference-file errors in Flow RPC.
  if (text.includes("public_error_unknown_image_file_format")) {
    return {
      code: "FLOW_REFERENCE_FORMAT_INVALID",

      summary: "Google Flow could not read the reference image format",
    };
  }
  if (text.includes("public_error_image_too_large")) {
    return {
      code: "FLOW_REFERENCE_TOO_LARGE",

      summary: "Google Flow rejected the reference image size",
    };
  }
  if (text.includes("public_error_user_region_disallowed")) {
    return {
      code: "FLOW_USER_REGION_DISALLOWED",

      summary: "Google Flow is not available for this account region",
    };
  }
  if (text.includes("public_error_user_minor")) {
    return {
      code: "FLOW_USER_MINOR",

      summary: "Google Flow does not allow this account age category",
    };
  }
  if (text.includes("public_error_project_not_allowlisted")) {
    return {
      code: "FLOW_PROJECT_NOT_ALLOWLISTED",

      summary: "Google Flow has not enabled this account project",
    };
  }
  if (text.includes("public_error_user_role_not_granted")) {
    return {
      code: "FLOW_USER_ROLE_NOT_GRANTED",

      summary: "Google Flow has not granted the required role to this account",
    };
  }
  if (text.includes("public_error_project_flow_enterprise_not_enabled")) {
    return {
      code: "FLOW_ENTERPRISE_NOT_ENABLED",

      summary: "Google Flow Enterprise is not enabled for this account project",
    };
  }
  if (text.includes("public_error_vertex_quota_exhausted_admin")) {
    return {
      code: "FLOW_VERTEX_QUOTA_EXHAUSTED_ADMIN",

      summary:
        "Google Flow reports that an administrator must restore this model quota",
    };
  }
  if (text.includes("public_error_vertex_quota_exhausted")) {
    return {
      code: "FLOW_VERTEX_QUOTA_EXHAUSTED",

      summary: "Google Flow reports that this model quota is exhausted",
    };
  }
  if (text.includes("public_error_video_generation_timed_out")) {
    // A timeout on an RPC request is not proof that an accepted generation
    // failed. A terminal media status describes the original generation failure.
    return {
      code: generationFailed
        ? "FLOW_VIDEO_GENERATION_TIMED_OUT"
        : "FLOW_SUBMISSION_OUTCOME_UNKNOWN",

      summary: generationFailed
        ? "Google Flow ended the video generation with a timeout"
        : "Google Flow reported a timeout; reconcile the accepted generation before resubmitting",
    };
  }

  if (includesAny(text, PROMINENT_PERSON_MARKERS)) {
    return {
      code: "FLOW_PROMINENT_PERSON",

      summary:
        "Google Flow does not generate prominent people; rewrite the scene without naming the person",
    };
  }

  // A generated output can be rejected even when the submitted prompt itself
  // was accepted. Keep this distinct from prompt-policy rejection so the UI
  // does not falsely accuse the user's prompt. This check must precede the
  // broader Flow safety marker because the donor signal can contain both.
  if (includesAny(text, GENERATION_REJECTION_MARKERS)) {
    return {
      code: "FLOW_GENERATION_REJECTED",

      summary: "Google Flow rejected the generated output",
    };
  }

  if (includesAny(text, PROMPT_SAFETY_MARKERS)) {
    return {
      code: "FLOW_PROMPT_SAFETY",

      summary: "Google Flow rejected the prompt for safety reasons",
    };
  }

  // Native image HAR: RESOURCE_EXHAUSTED wraps this precise ErrorInfo reason.
  // It exhausts one model, not every image/video capability on the account.
  if (text.includes("public_error_per_model_daily_quota_reached")) {
    return {
      code: "FLOW_PER_MODEL_DAILY_QUOTA_REACHED",

      summary:
        "Google Flow reports this model's daily quota has been reached for this account",
    };
  }

  if (text.includes("public_error_user_quota_reached")) {
    return {
      code: "FLOW_USER_QUOTA_REACHED",

      summary: "Google Flow reports this account's user quota has been reached",
    };
  }

  if (text.includes("public_error_workspace_account_quota_reached")) {
    return {
      code: "FLOW_WORKSPACE_QUOTA_REACHED",

      summary:
        "Google Flow reports this workspace account's quota has been reached",
    };
  }

  if (includesAny(text, DAILY_QUOTA_MARKERS)) {
    return {
      code: "FLOW_MODEL_DAILY_QUOTA_REACHED",

      summary:
        "Google Flow reports this model's daily quota has been reached for this account",
    };
  }

  // Explicit anti-abuse evidence wins over the outer captcha failure. Do not
  // ask for another token or submit again against an already flagged session.
  if (includesAny(text, SESSION_HEAT_TEXT_MARKERS)) {
    return {
      code: "FLOW_SESSION_HEAT",

      summary:
        "Google Flow flagged unusual activity; rest this account before resuming",
    };
  }
  // A rejected token is a definitive response: no generation was accepted.
  // Keep it distinct from wider session heat so the caller can execute a
  // fresh page-owned token instead of retrying the already rejected token.
  if (includesAny(text, CAPTCHA_REJECTION_MARKERS)) {
    return {
      code: "FLOW_CAPTCHA_REJECTED",

      summary: "Google Flow rejected the reCAPTCHA token",
    };
  }

  // Observed from flowMedia:batchGenerateImages after a successful large
  // batch. This is a temporary per-account request throttle, not unusual
  // activity and not service-wide capacity. The driver reports it at once so
  // the broker can fail over without repeating the rejected submit locally.
  if (includesAny(text, ACCOUNT_THROTTLE_MARKERS)) {
    return {
      code: "FLOW_ACCOUNT_THROTTLED",

      summary: "Google Flow temporarily rate-limited this account",
    };
  }

  // RESOURCE_EXHAUSTED alone proves neither unusual activity nor a failed
  // captcha. Specific quota/throttle reasons above win; the generic signal
  // remains capacity below, without persisting false session heat.

  //: Checked on its own text rather than on a bare 403. A free account is
  //: refused Veo with "the caller does not have permission" while the same
  //: account draws and speaks perfectly, so this is an entitlement, not a
  //: session that has grown hot: waiting cannot earn the permission.
  if (includesAny(text, ACCESS_DENIED_MARKERS)) {
    return {
      code: "FLOW_MODEL_ACCESS_DENIED",

      summary: "Google Flow does not serve this model to this account",
    };
  }

  // Google uses this standard status for a request it has already decided it
  // cannot accept. Repeating the identical prompt, shape and model on every
  // paired account cannot repair it; it only spends captcha work and stalls
  // the rest of the queue. More specific safety/auth/quota signals above keep
  // their narrower classifications when Google includes one.
  if (
    status === 400 &&
    includesAny(text, INVALID_ARGUMENT_MARKERS) &&
    !includesAny(text, CAPACITY_TEXT_MARKERS)
  ) {
    return {
      code: "FLOW_REQUEST_INVALID",

      summary:
        "Google Flow rejected this request as invalid; regenerate the scene, then check " +
        "provider and model settings if it repeats",
    };
  }

  // Only an explicit RPC authentication rejection proves the session was refused. Policy,
  // captcha and anti-abuse evidence above must never become an auth retry.
  if (status === 401) {
    return {
      code: "FLOW_AUTH_REJECTED",

      summary: "Google Flow rejected the page RPC session",
    };
  }

  const isCapacity = includesAny(text, CAPACITY_TEXT_MARKERS) || status === 429;
  if (isCapacity) {
    return {
      code: "FLOW_CAPACITY",

      summary: "Google Flow is at capacity; try again later",
    };
  }

  return null;
}
