-- CreateEnum
CREATE TYPE "CartStatus" AS ENUM ('OPEN', 'CHECKED_OUT');

-- CreateEnum
CREATE TYPE "CouponStatus" AS ENUM ('AVAILABLE', 'REDEEMED');

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "stock" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status" "CartStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checked_out_at" TIMESTAMP(3),

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "cart_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_at_add" DECIMAL(12,2) NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("cart_id","product_id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_number" BIGSERIAL NOT NULL,
    "cart_id" UUID NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "coupon_id" UUID,
    "coupon_code" TEXT,
    "discount_percent" INTEGER,
    "placed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "product_name" TEXT NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "line_total" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "milestone" INTEGER NOT NULL,
    "discount_percent" INTEGER NOT NULL,
    "status" "CouponStatus" NOT NULL DEFAULT 'AVAILABLE',
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redeemed_at" TIMESTAMP(3),
    "redeemed_order_id" UUID,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE UNIQUE INDEX "orders_cart_id_key" ON "orders"("cart_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_coupon_id_key" ON "orders"("coupon_id");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_items_product_id_idx" ON "order_items"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_milestone_key" ON "coupons"("milestone");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_redeemed_order_id_key" ON "coupons"("redeemed_order_id");

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Hand-written CHECK constraints (Prisma's schema DSL cannot express them).
-- These are the database-level backstops for the invariants in DECISIONS.md: even a bug in the
-- application code cannot persist a negative stock, an unbalanced order, or a bad coupon.
-- ---------------------------------------------------------------------------------------------

-- I1: stock never negative; prices never negative
ALTER TABLE "products" ADD CONSTRAINT "products_price_non_negative" CHECK ("price" >= 0);
ALTER TABLE "products" ADD CONSTRAINT "products_stock_non_negative" CHECK ("stock" >= 0);

-- cart state is consistent and quantities are within the allowed range
ALTER TABLE "carts" ADD CONSTRAINT "carts_checked_out_at_matches_status"
  CHECK (("status" = 'CHECKED_OUT') = ("checked_out_at" IS NOT NULL));
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_quantity_range" CHECK ("quantity" BETWEEN 1 AND 99);
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_unit_price_at_add_non_negative" CHECK ("unit_price_at_add" >= 0);

-- I8: 0 <= total <= subtotal and total = subtotal - discount
ALTER TABLE "orders" ADD CONSTRAINT "orders_amounts_balance" CHECK (
  "subtotal" >= 0 AND "discount" >= 0 AND "discount" <= "subtotal" AND "total" = "subtotal" - "discount"
);
-- coupon snapshot fields are all present or all absent, and a discount requires a coupon
ALTER TABLE "orders" ADD CONSTRAINT "orders_coupon_snapshot_consistent" CHECK (
  ("coupon_id" IS NULL) = ("coupon_code" IS NULL)
  AND ("coupon_id" IS NULL) = ("discount_percent" IS NULL)
  AND ("discount_percent" IS NULL OR "discount_percent" BETWEEN 0 AND 100)
  AND ("discount" = 0 OR "coupon_id" IS NOT NULL)
);

-- I7: order lines are internally consistent
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_amounts_balance" CHECK (
  "unit_price" >= 0 AND "line_total" = "unit_price" * "quantity"
);

-- coupons: valid milestone/percent, and a redeemed coupon has a redemption time
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_milestone_positive" CHECK ("milestone" >= 1);
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_discount_percent_range" CHECK ("discount_percent" BETWEEN 1 AND 100);
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_redeemed_at_matches_status"
  CHECK (("status" = 'REDEEMED') = ("redeemed_at" IS NOT NULL));
