import { Elysia, t } from "elysia";
import { ErrorResponse } from "../schemas/common";
import { CouponListQuery, CouponModel } from "../schemas/coupon";
import type { CouponService } from "../services/coupon.service";

/** Administrative operations. Authentication is out of scope; this group is where a guard would go. */
export const adminRouter = (coupons: CouponService) =>
	new Elysia({ prefix: "/admin", tags: ["Admin"] })
		.post(
			"/coupons/generate",
			async ({ set }) => {
				const coupon = await coupons.generate();
				set.status = 201;
				return coupon;
			},
			{
				response: { 201: CouponModel, 409: ErrorResponse },
				detail: {
					summary: "Generate a coupon for an unrewarded milestone",
					description:
						"Every n-th successfully placed order reaches a milestone. This creates one coupon for the " +
						"lowest milestone that has been reached and not yet rewarded. Call it again for the next one. " +
						"Safe under concurrency: simultaneous calls never create two coupons for one milestone.\\n\\n" +
						"Errors: `409 NO_ELIGIBLE_MILESTONE` (details show orders placed and orders until the next milestone).",
				},
			},
		)
		.get("/coupons", ({ query }) => coupons.list(query.status), {
			query: CouponListQuery,
			response: { 200: t.Array(CouponModel), 400: ErrorResponse },
			detail: {
				summary: "List coupons",
				description: "All generated coupons ordered by milestone, optionally filtered by `status`.",
			},
		});
