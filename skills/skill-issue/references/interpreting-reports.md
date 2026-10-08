# Interpreting a Skill Issue report

Wording rules with examples. Copy the discipline, adjust the words.

## Normal case: both variants completed, comparison valid

> The skill variant passed the verifier (RELEASE_NOTES.md has the three
> required sections); the baseline did not. The skill was installed in its
> workspace and the run's event stream shows it being invoked. This is one
> repetition — it describes what happened in this run; it does not establish
> that the skill is generally better.

Include duration/tokens only if present, e.g. "duration 41 s vs 63 s" and
"tokens not reported by this runner" when absent.

## No token/cost numbers

Never write "0 tokens" or "free". Say exactly:

> Tokens and cost are not measured in this report — the runner's result
> message did not include usage. Duration is the only resource measurement
> available (engine wall clock).

## Skill installed but never read

> The skill was installed in the workspace, but the event stream shows no
> Skill invocation and no read of its files. Whatever the task outcome, this
> run provides no evidence that the skill's content influenced it.

## Baseline passed too

> Both variants passed the verifier on this task. With one repetition each,
> there is no observable difference to explain; more repetitions or a harder
> task would be needed before claiming the skill matters here.

## infrastructure_error

> The run died of an infrastructure problem (e.g. authentication failure,
> corrupt output stream). This is not a task failure and not evidence about
> the skill. The harness records the runner stderr tail with the record.

## invalid_comparison

> The engine rejected this comparison because <reasons from the report —
> e.g. initial workspace bytes differed between variants / verifier files
> changed during the run>. No conclusion about the skill can be drawn from
> these records.

## The user asks "so is it the best skill?" after one run

Refuse the claim, offer the honest statement:

> One valid comparison shows the skill variant passing where the baseline
> failed, on this task, with this model, once. That is a reason to keep the
> skill for this kind of task — not a ranking. To say more I would need
> several repetitions and additional tasks.

## Timeout / cancellation

> The <variant> run exceeded the <N> ms wall-clock limit and its process tree
> was killed; the verifier never ran. The status is `timeout`, which is
> distinct from failing the task.
