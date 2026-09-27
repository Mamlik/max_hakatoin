import type { FastifyInstance } from "fastify";
import { route, audit } from "./http.js";
import { one, type DB } from "../db/db.js";
import { fail, required } from "./errors.js";
import { visitReviewCreate, visitReviewUpdate } from "../contracts/schemas.js";
import type { Actor, Booking, VisitReview } from "./types.js";

type ReviewBooking = Booking & { staff_name: string; tenant_name: string };

async function ownedCompletedBooking(db: DB, actor: Actor, bookingId: string) {
  const booking = required(
    await one<ReviewBooking>(
      db,
      `SELECT b.*,s.name staff_name,t.name tenant_name
       FROM bookings b
       JOIN staff s ON s.id=b.staff_id AND s.tenant_id=b.tenant_id
       JOIN tenants t ON t.id=b.tenant_id
       WHERE b.id=$1 AND b.user_id=$2
       FOR UPDATE OF b`,
      [bookingId, actor.id],
    ),
  );
  if (booking.status !== "completed")
    fail(
      409,
      "BOOKING_NOT_COMPLETED",
      "Оценить мастера можно только после завершённого визита",
    );
  return booking;
}

export function reviewDTO(review: VisitReview) {
  return {
    id: review.id,
    rating: review.rating,
    status: review.status,
    version: review.version,
    staffNameSnapshot: review.staff_name_snapshot,
    tenantNameSnapshot: review.tenant_name_snapshot,
    createdAt: review.created_at,
    updatedAt: review.updated_at,
    invalidatedReason: review.invalidated_reason,
  };
}

export function reviewRoutes(app: FastifyInstance) {
  route(
    app,
    "POST",
    "/api/v1/me/bookings/:b/review",
    {
      schema: visitReviewCreate,
      description: "Оценить мастера после завершённого визита",
    },
    async ({ db, actor, p, b }) => {
      const booking = await ownedCompletedBooking(db, actor, p.b!);
      const previous = await one<VisitReview>(
        db,
        "SELECT * FROM visit_reviews WHERE booking_id=$1 AND user_id=$2 FOR UPDATE",
        [booking.id, actor.id],
      );
      let review: VisitReview;
      let action: "review.created" | "review.reactivated";
      if (!previous) {
        review = (await one<VisitReview>(
          db,
          `INSERT INTO visit_reviews(
             tenant_id,booking_id,user_id,staff_id,rating,
             staff_name_snapshot,tenant_name_snapshot
           ) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            booking.tenant_id,
            booking.id,
            actor.id,
            booking.staff_id,
            b.rating,
            booking.staff_name,
            booking.tenant_name,
          ],
        ))!;
        action = "review.created";
      } else {
        if (previous.status === "active")
          fail(
            409,
            "REVIEW_ALREADY_EXISTS",
            "Оценка этого визита уже сохранена",
          );
        review = (await one<VisitReview>(
          db,
          `UPDATE visit_reviews
           SET rating=$2,status='active',invalidated_reason=NULL,
               invalidated_at=NULL,staff_id=$3,staff_name_snapshot=$4,
               tenant_name_snapshot=$5,updated_at=now(),version=version+1
           WHERE id=$1 RETURNING *`,
          [
            previous.id,
            b.rating,
            booking.staff_id,
            booking.staff_name,
            booking.tenant_name,
          ],
        ))!;
        action = "review.reactivated";
      }
      await audit(db, booking.tenant_id, actor.id, action, review.id, {
        bookingId: booking.id,
        staffId: booking.staff_id,
        rating: review.rating,
      });
      return reviewDTO(review);
    },
  );

  route(
    app,
    "PATCH",
    "/api/v1/me/bookings/:b/review",
    {
      schema: visitReviewUpdate,
      description: "Изменить собственную оценку завершённого визита",
    },
    async ({ db, actor, p, b }) => {
      const booking = await ownedCompletedBooking(db, actor, p.b!);
      const previous = required(
        await one<VisitReview>(
          db,
          "SELECT * FROM visit_reviews WHERE booking_id=$1 AND user_id=$2 FOR UPDATE",
          [booking.id, actor.id],
        ),
      );
      if (previous.status !== "active")
        fail(
          409,
          "REVIEW_INVALIDATED",
          "Эта оценка больше не учитывается. Отправьте новую после подтверждения визита.",
        );
      if (previous.version !== b.expectedVersion)
        fail(
          409,
          "VERSION_CONFLICT",
          "Оценка уже изменилась. Обновите страницу и повторите действие.",
        );
      const review = (await one<VisitReview>(
        db,
        `UPDATE visit_reviews SET rating=$2,updated_at=now(),version=version+1
         WHERE id=$1 AND version=$3 RETURNING *`,
        [previous.id, b.rating, b.expectedVersion],
      ))!;
      await audit(db, booking.tenant_id, actor.id, "review.updated", review.id, {
        bookingId: booking.id,
        staffId: booking.staff_id,
        fromRating: previous.rating,
        toRating: review.rating,
      });
      return reviewDTO(review);
    },
  );
}
