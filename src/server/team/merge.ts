import type { Db } from '../db';

/** Keep secondary rows for a reversible merge, including conflicting owners and overlaps. */
export async function mergeAssignments(tx: Db, primary: string, secondary: string) {
  const before = await tx.query('SELECT * FROM opportunity_assignments WHERE opportunity_id=$1 ORDER BY id FOR UPDATE', [secondary]);
  for (const row of before) {
    const conflict = row.active && await tx.one(`SELECT 1 FROM opportunity_assignments WHERE opportunity_id=$1 AND active AND (user_id=$2 OR (assignment_role='owner' AND $3='owner'))`, [primary,row.user_id,row.assignment_role]);
    // A second distinct owner becomes a collaborator; overlapping users remain in preserved history.
    const overlap = conflict && await tx.one('SELECT 1 FROM opportunity_assignments WHERE opportunity_id=$1 AND active AND user_id=$2', [primary,row.user_id]);
    await tx.query('UPDATE opportunity_assignments SET opportunity_id=$2,active=$3,assignment_role=$4,version=version+1 WHERE id=$1', [row.id, primary, row.active && !overlap, conflict && !overlap ? 'collaborator' : row.assignment_role]);
  }
  await tx.query('UPDATE opportunities SET assignment_revision=assignment_revision+1 WHERE id=ANY($1::uuid[])', [[primary,secondary]]);
  return before;
}
export async function undoAssignments(tx: Db, rows: any[]) {
  for (const row of rows) {
    const current = await tx.one('SELECT * FROM opportunity_assignments WHERE id=$1 FOR UPDATE', [row.id]);
    if (!current || current.version !== row.version + 1) throw new Error('Assignments changed after merge. Resolve those changes before undoing.');
    await tx.query('UPDATE opportunity_assignments SET opportunity_id=$2,active=$3,assignment_role=$4,version=version+1 WHERE id=$1', [row.id,row.opportunity_id,row.active,row.assignment_role]);
  }
}
