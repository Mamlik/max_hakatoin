-- Packages can be applied to several appointments. Reservation capacity is
-- enforced transactionally through voucher_uses; single-use vouchers retain
-- their issued/reserved/redeemed state gate.
DROP INDEX booking_voucher;
CREATE INDEX booking_voucher ON bookings(applied_voucher_id) WHERE applied_voucher_id IS NOT NULL;
