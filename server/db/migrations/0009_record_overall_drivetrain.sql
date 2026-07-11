-- Allow mixed-drivetrain DUO record runs to store under the 'overall' sentinel.
-- A duo where the two robots use DIFFERENT drivetrains is now permitted; such a
-- run counts on the OVERALL record board only, never a drivetrain-specific one
-- (decided in persist.ts, mirroring the ranked-ELO rule in computeGlicko). The
-- elo_ratings.drivetrain column already permits 'overall'; this brings records
-- into line.
alter table records drop constraint if exists records_drivetrain_check;
alter table records add constraint records_drivetrain_check
  check (drivetrain in ('mecanum', 'tank', 'swerve', 'xdrive', 'overall'));
