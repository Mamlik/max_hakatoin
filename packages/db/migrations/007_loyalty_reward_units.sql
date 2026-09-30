-- Legacy inserts omitted the free-visit quantity after migration 006 removed its default.
UPDATE loyalty_programs SET free_visits_count=1
WHERE reward_type='free_visits' AND free_visits_count IS NULL;

UPDATE loyalty_rewards r SET free_visits_count=1,
  terms_snapshot=terms_snapshot || '{"freeVisitsCount":1}'::jsonb,
  remaining_visits=CASE WHEN status='redeemed' THEN 0 ELSE GREATEST(0,1-(
    SELECT count(*)::int FROM loyalty_reward_uses u WHERE u.reward_id=r.id AND u.status='redeemed'
  )) END
WHERE reward_type='free_visits' AND free_visits_count IS NULL;

ALTER TABLE loyalty_programs ADD CONSTRAINT loyalty_program_value_present CHECK (
  (reward_type='fixed' AND fixed_discount_minor IS NOT NULL) OR
  (reward_type='percent' AND discount_percent IS NOT NULL) OR
  (reward_type='free_visits' AND free_visits_count IS NOT NULL));
ALTER TABLE loyalty_rewards ADD CONSTRAINT loyalty_reward_value_present CHECK (
  (reward_type='fixed' AND fixed_discount_minor IS NOT NULL) OR
  (reward_type='percent' AND discount_percent IS NOT NULL) OR
  (reward_type='free_visits' AND free_visits_count IS NOT NULL));
