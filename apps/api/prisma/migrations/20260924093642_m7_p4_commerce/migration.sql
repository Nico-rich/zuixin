-- CreateTable
CREATE TABLE "CommerceProduct" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "connectionId" TEXT,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "price" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "status" TEXT NOT NULL DEFAULT 'active',
    "sku" TEXT,
    "imageUrl" TEXT,
    "inventory" INTEGER,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommerceProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceOrder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "connectionId" TEXT,
    "externalId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "orderedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommerceOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "totalPrice" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "CommerceOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceTrafficMetric" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "connectionId" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "dimension" TEXT NOT NULL DEFAULT 'all',
    "dimensionValue" TEXT NOT NULL DEFAULT 'all',
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "visits" INTEGER NOT NULL DEFAULT 0,
    "uniqueVisitors" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CommerceTrafficMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceConversionMetric" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "connectionId" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "dimension" TEXT NOT NULL DEFAULT 'all',
    "dimensionValue" TEXT NOT NULL DEFAULT 'all',
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "addToCart" INTEGER NOT NULL DEFAULT 0,
    "checkouts" INTEGER NOT NULL DEFAULT 0,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "CommerceConversionMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceCampaign" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "connectionId" TEXT,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "objective" TEXT,
    "budget" DOUBLE PRECISION,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommerceCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceAdGroup" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "CommerceAdGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceAd" (
    "id" TEXT NOT NULL,
    "adGroupId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "creativeType" TEXT NOT NULL DEFAULT 'image',
    "previewUrl" TEXT,

    CONSTRAINT "CommerceAd_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceAdMetric" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "connectionId" TEXT,
    "campaignId" TEXT,
    "adId" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,
    "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "CommerceAdMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceInventoryMetric" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "connectionId" TEXT,
    "productId" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "sold" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CommerceInventoryMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceRevenueMetric" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "connectionId" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "refunds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "CommerceRevenueMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommerceProduct_userId_provider_status_idx" ON "CommerceProduct"("userId", "provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceProduct_userId_provider_externalId_key" ON "CommerceProduct"("userId", "provider", "externalId");

-- CreateIndex
CREATE INDEX "CommerceOrder_userId_provider_orderedAt_idx" ON "CommerceOrder"("userId", "provider", "orderedAt");

-- CreateIndex
CREATE INDEX "CommerceOrder_userId_provider_status_idx" ON "CommerceOrder"("userId", "provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceOrder_userId_provider_externalId_key" ON "CommerceOrder"("userId", "provider", "externalId");

-- CreateIndex
CREATE INDEX "CommerceOrderItem_orderId_idx" ON "CommerceOrderItem"("orderId");

-- CreateIndex
CREATE INDEX "CommerceTrafficMetric_userId_provider_periodStart_dimension_idx" ON "CommerceTrafficMetric"("userId", "provider", "periodStart", "dimension", "dimensionValue");

-- CreateIndex
CREATE INDEX "CommerceConversionMetric_userId_provider_periodStart_dimens_idx" ON "CommerceConversionMetric"("userId", "provider", "periodStart", "dimension", "dimensionValue");

-- CreateIndex
CREATE INDEX "CommerceCampaign_userId_provider_status_idx" ON "CommerceCampaign"("userId", "provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceCampaign_userId_provider_externalId_key" ON "CommerceCampaign"("userId", "provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceAdGroup_campaignId_externalId_key" ON "CommerceAdGroup"("campaignId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceAd_adGroupId_externalId_key" ON "CommerceAd"("adGroupId", "externalId");

-- CreateIndex
CREATE INDEX "CommerceAdMetric_userId_provider_periodStart_campaignId_idx" ON "CommerceAdMetric"("userId", "provider", "periodStart", "campaignId");

-- CreateIndex
CREATE INDEX "CommerceAdMetric_userId_provider_periodStart_adId_idx" ON "CommerceAdMetric"("userId", "provider", "periodStart", "adId");

-- CreateIndex
CREATE INDEX "CommerceInventoryMetric_userId_provider_periodStart_product_idx" ON "CommerceInventoryMetric"("userId", "provider", "periodStart", "productId");

-- CreateIndex
CREATE INDEX "CommerceRevenueMetric_userId_provider_periodStart_idx" ON "CommerceRevenueMetric"("userId", "provider", "periodStart");

-- AddForeignKey
ALTER TABLE "CommerceProduct" ADD CONSTRAINT "CommerceProduct_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrder" ADD CONSTRAINT "CommerceOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrderItem" ADD CONSTRAINT "CommerceOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceTrafficMetric" ADD CONSTRAINT "CommerceTrafficMetric_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceConversionMetric" ADD CONSTRAINT "CommerceConversionMetric_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceCampaign" ADD CONSTRAINT "CommerceCampaign_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceAdGroup" ADD CONSTRAINT "CommerceAdGroup_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CommerceCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceAd" ADD CONSTRAINT "CommerceAd_adGroupId_fkey" FOREIGN KEY ("adGroupId") REFERENCES "CommerceAdGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceAdMetric" ADD CONSTRAINT "CommerceAdMetric_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceInventoryMetric" ADD CONSTRAINT "CommerceInventoryMetric_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceRevenueMetric" ADD CONSTRAINT "CommerceRevenueMetric_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
