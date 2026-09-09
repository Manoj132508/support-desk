/**
 * Append-only enforcement for the audit spine. INV-B, ADR 0006.
 * Ported in shape from Project 2.
 *
 * The claim INV-A makes -- the model never takes an unauthorised action -- is
 * only as good as the record of what it tried. An audit row that can be edited
 * proves nothing: anyone reading it has to ask whether it says what it said
 * when it was written.
 *
 * So this plugin removes the ability, rather than the intention. Every write
 * path Mongoose offers is blocked except the initial insert, at the MODEL
 * level, so no controller can violate immutability by accident and no future
 * contributor can do it by not knowing.
 *
 * DELETES ARE BLOCKED TOO. "Append-only" that permits deletion is not
 * append-only, and deletion is exactly what a bad actor would reach for. The
 * deletion-request path does not need it: de-identification scrubs the
 * `Customer` document and leaves audit rows untouched (ADR 0006 amendment), so
 * there is no legitimate caller for a delete here.
 */

const BLOCKED_QUERY_OPS = [
  'update',
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findByIdAndUpdate',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'findByIdAndDelete',
  'findOneAndRemove',
];

export class ImmutableError extends Error {
  constructor(modelName, operation) {
    super(
      `${modelName} is append-only (INV-B): ${operation} is not permitted. ` +
        'Express a change by appending a new record.',
    );
    this.name = 'ImmutableError';
    this.modelName = modelName;
    this.operation = operation;
  }
}

export function immutablePlugin(schema) {
  for (const op of BLOCKED_QUERY_OPS) {
    schema.pre(op, function blockQueryWrite(next) {
      next(new ImmutableError(this.model?.modelName ?? 'document', op));
    });
  }

  /**
   * `save()` on an already-persisted document.
   *
   * `isNew` is the discriminator: an insert is legal, a re-save is not. Without
   * this, the query-level blocks above are trivially bypassed by loading a
   * document, mutating a field and calling save() -- which is the most natural
   * thing a developer would write.
   *
   * Registered on `validate` as well as `save`, and the order matters. Mongoose
   * runs field validation as a pre-save hook of its own, registered before any
   * plugin's, so a `save`-only block reports "tenantId is required" for an
   * edit that was never permitted in the first place. Blocking at `validate`
   * puts the real reason first: the operation is forbidden, and whether the
   * edited document would have been valid is beside the point.
   */
  function blockResave(next) {
    if (this.isNew) return next();
    next(new ImmutableError(this.constructor?.modelName ?? 'document', 'save'));
  }

  schema.pre('validate', blockResave);
  schema.pre('save', blockResave);

  /** Bulk writes bypass per-operation hooks, so they are refused wholesale. */
  schema.pre('bulkWrite', function blockBulkWrite(next) {
    next(new ImmutableError(this.modelName ?? 'document', 'bulkWrite'));
  });

  schema.set('strict', 'throw');
}

export { BLOCKED_QUERY_OPS };
