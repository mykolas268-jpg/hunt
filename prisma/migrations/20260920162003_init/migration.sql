-- CreateEnum
CREATE TYPE "SupplierProvider" AS ENUM ('CJ');

-- CreateEnum
CREATE TYPE "SupplierAccountStatus" AS ENUM ('ACTIVE', 'INVALID', 'RATE_LIMITED');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'GENERATING', 'READY', 'PUSHING', 'SYNCED', 'ERROR');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('PENDING', 'GENERATED', 'APPROVED', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "Completeness" AS ENUM ('EMPTY', 'PARTIAL', 'COMPLETE');

-- CreateEnum
CREATE TYPE "Rounding" AS ENUM ('NONE', 'END_99', 'END_95', 'NEAREST');

-- CreateEnum
CREATE TYPE "VatHandling" AS ENUM ('ADD_VAT', 'PRICE_IS_GROSS');

-- CreateEnum
CREATE TYPE "ChangeType" AS ENUM ('COST_UP', 'COST_DOWN', 'STOCK_OUT', 'STOCK_IN', 'DISCONTINUED');

-- CreateEnum
CREATE TYPE "ChangeStatus" AS ENUM ('NEW', 'APPLIED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "GenerationKind" AS ENUM ('LISTING', 'COMPLIANCE');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "planHandle" TEXT,
    "onboardingState" TEXT NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierAccount" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "provider" "SupplierProvider" NOT NULL DEFAULT 'CJ',
    "email" TEXT NOT NULL,
    "apiKeyEnc" TEXT NOT NULL,
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "lastAuthAt" TIMESTAMP(3),
    "status" "SupplierAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierProduct" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "supplierAccountId" TEXT NOT NULL,
    "provider" "SupplierProvider" NOT NULL DEFAULT 'CJ',
    "supplierProductId" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "titleRaw" TEXT NOT NULL,
    "descriptionRaw" TEXT,
    "categoryPath" TEXT,
    "weightGrams" INTEGER,
    "imageUrls" TEXT[],
    "rawPayload" JSONB NOT NULL,
    "lastFetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierVariant" (
    "id" TEXT NOT NULL,
    "supplierProductId" TEXT NOT NULL,
    "supplierVariantId" TEXT NOT NULL,
    "sku" TEXT,
    "optionValues" JSONB NOT NULL,
    "costMinor" INTEGER NOT NULL,
    "costCurrency" TEXT NOT NULL,
    "stockQty" INTEGER NOT NULL DEFAULT 0,
    "weightGrams" INTEGER,
    "imageUrl" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "discontinuedAt" TIMESTAMP(3),

    CONSTRAINT "SupplierVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "languageCode" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "vatRateBp" INTEGER NOT NULL DEFAULT 0,
    "responsiblePersonId" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResponsiblePerson" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResponsiblePerson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "supplierProductId" TEXT NOT NULL,
    "shopifyProductId" TEXT,
    "pricingRuleId" TEXT,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "lastError" TEXT,
    "lastPushedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariantMap" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierVariantId" TEXT NOT NULL,
    "shopifyVariantId" TEXT,
    "shopifyInventoryItemId" TEXT,
    "lastKnownCostMinor" INTEGER,
    "lastPushedPriceMinor" INTEGER,
    "lastKnownStock" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariantMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "title" TEXT,
    "descriptionHtml" TEXT,
    "bullets" JSONB,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "tags" TEXT[],
    "tonePreset" TEXT NOT NULL DEFAULT 'professional',
    "status" "ListingStatus" NOT NULL DEFAULT 'PENDING',
    "model" TEXT,
    "promptVersion" TEXT,
    "generatedAt" TIMESTAMP(3),
    "humanEdited" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceRecord" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "responsiblePersonId" TEXT,
    "manufacturerName" TEXT,
    "manufacturerAddress" TEXT,
    "manufacturerEmail" TEXT,
    "productIdentifiers" JSONB,
    "warnings" TEXT,
    "safetyInstructions" TEXT,
    "careInstructions" TEXT,
    "ageRestriction" TEXT,
    "certifications" JSONB,
    "fieldProvenance" JSONB,
    "completeness" "Completeness" NOT NULL DEFAULT 'EMPTY',
    "merchantReviewedAt" TIMESTAMP(3),
    "merchantReviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRule" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "multiplierBp" INTEGER NOT NULL DEFAULT 20000,
    "fixedFeeMinor" INTEGER NOT NULL DEFAULT 0,
    "rounding" "Rounding" NOT NULL DEFAULT 'END_99',
    "compareAtMultiplierBp" INTEGER,
    "minMarginMinor" INTEGER NOT NULL DEFAULT 0,
    "includeShipping" BOOLEAN NOT NULL DEFAULT false,
    "vatHandling" "VatHandling" NOT NULL DEFAULT 'ADD_VAT',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceTier" (
    "id" TEXT NOT NULL,
    "pricingRuleId" TEXT NOT NULL,
    "minCostMinor" INTEGER NOT NULL,
    "maxCostMinor" INTEGER,
    "multiplierBp" INTEGER NOT NULL,
    "fixedFeeMinor" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PriceTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FxRate" (
    "id" TEXT NOT NULL,
    "baseCurrency" TEXT NOT NULL,
    "quoteCurrency" TEXT NOT NULL,
    "rateBp" INTEGER NOT NULL,
    "asOfDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FxRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierChangeEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierVariantId" TEXT NOT NULL,
    "type" "ChangeType" NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "ChangeStatus" NOT NULL DEFAULT 'NEW',
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "SupplierChangeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiGeneration" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "listingId" TEXT,
    "kind" "GenerationKind" NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "promptVersion" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateBucket" (
    "id" TEXT NOT NULL,
    "supplierAccountId" TEXT NOT NULL,
    "tokens" DOUBLE PRECISION NOT NULL,
    "capacity" DOUBLE PRECISION NOT NULL,
    "refillPerSecond" DOUBLE PRECISION NOT NULL,
    "lastRefillAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopifyEventId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "Shop_uninstalledAt_idx" ON "Shop"("uninstalledAt");

-- CreateIndex
CREATE INDEX "SupplierAccount_shopId_idx" ON "SupplierAccount"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierAccount_shopId_provider_key" ON "SupplierAccount"("shopId", "provider");

-- CreateIndex
CREATE INDEX "SupplierProduct_shopId_idx" ON "SupplierProduct"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProduct_supplierAccountId_supplierProductId_key" ON "SupplierProduct"("supplierAccountId", "supplierProductId");

-- CreateIndex
CREATE INDEX "SupplierVariant_supplierProductId_idx" ON "SupplierVariant"("supplierProductId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierVariant_supplierProductId_supplierVariantId_key" ON "SupplierVariant"("supplierProductId", "supplierVariantId");

-- CreateIndex
CREATE INDEX "Market_shopId_idx" ON "Market"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "Market_shopId_countryCode_key" ON "Market"("shopId", "countryCode");

-- CreateIndex
CREATE INDEX "ResponsiblePerson_shopId_idx" ON "ResponsiblePerson"("shopId");

-- CreateIndex
CREATE INDEX "Product_shopId_status_idx" ON "Product"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Product_shopId_supplierProductId_key" ON "Product"("shopId", "supplierProductId");

-- CreateIndex
CREATE INDEX "ProductVariantMap_productId_idx" ON "ProductVariantMap"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariantMap_productId_supplierVariantId_key" ON "ProductVariantMap"("productId", "supplierVariantId");

-- CreateIndex
CREATE INDEX "Listing_productId_idx" ON "Listing"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_productId_marketId_key" ON "Listing"("productId", "marketId");

-- CreateIndex
CREATE INDEX "ComplianceRecord_productId_idx" ON "ComplianceRecord"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceRecord_productId_marketId_key" ON "ComplianceRecord"("productId", "marketId");

-- CreateIndex
CREATE INDEX "PricingRule_shopId_idx" ON "PricingRule"("shopId");

-- CreateIndex
CREATE INDEX "PriceTier_pricingRuleId_idx" ON "PriceTier"("pricingRuleId");

-- CreateIndex
CREATE INDEX "FxRate_baseCurrency_quoteCurrency_idx" ON "FxRate"("baseCurrency", "quoteCurrency");

-- CreateIndex
CREATE UNIQUE INDEX "FxRate_baseCurrency_quoteCurrency_asOfDate_key" ON "FxRate"("baseCurrency", "quoteCurrency", "asOfDate");

-- CreateIndex
CREATE INDEX "SupplierChangeEvent_shopId_status_idx" ON "SupplierChangeEvent"("shopId", "status");

-- CreateIndex
CREATE INDEX "SupplierChangeEvent_productId_idx" ON "SupplierChangeEvent"("productId");

-- CreateIndex
CREATE INDEX "AiGeneration_shopId_createdAt_idx" ON "AiGeneration"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RateBucket_supplierAccountId_key" ON "RateBucket"("supplierAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_shopifyEventId_key" ON "WebhookEvent"("shopifyEventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_shopDomain_topic_idx" ON "WebhookEvent"("shopDomain", "topic");

-- AddForeignKey
ALTER TABLE "SupplierAccount" ADD CONSTRAINT "SupplierAccount_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_supplierAccountId_fkey" FOREIGN KEY ("supplierAccountId") REFERENCES "SupplierAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierVariant" ADD CONSTRAINT "SupplierVariant_supplierProductId_fkey" FOREIGN KEY ("supplierProductId") REFERENCES "SupplierProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Market" ADD CONSTRAINT "Market_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Market" ADD CONSTRAINT "Market_responsiblePersonId_fkey" FOREIGN KEY ("responsiblePersonId") REFERENCES "ResponsiblePerson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResponsiblePerson" ADD CONSTRAINT "ResponsiblePerson_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_supplierProductId_fkey" FOREIGN KEY ("supplierProductId") REFERENCES "SupplierProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_pricingRuleId_fkey" FOREIGN KEY ("pricingRuleId") REFERENCES "PricingRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariantMap" ADD CONSTRAINT "ProductVariantMap_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariantMap" ADD CONSTRAINT "ProductVariantMap_supplierVariantId_fkey" FOREIGN KEY ("supplierVariantId") REFERENCES "SupplierVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceRecord" ADD CONSTRAINT "ComplianceRecord_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceRecord" ADD CONSTRAINT "ComplianceRecord_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceRecord" ADD CONSTRAINT "ComplianceRecord_responsiblePersonId_fkey" FOREIGN KEY ("responsiblePersonId") REFERENCES "ResponsiblePerson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceTier" ADD CONSTRAINT "PriceTier_pricingRuleId_fkey" FOREIGN KEY ("pricingRuleId") REFERENCES "PricingRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierChangeEvent" ADD CONSTRAINT "SupplierChangeEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierChangeEvent" ADD CONSTRAINT "SupplierChangeEvent_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierChangeEvent" ADD CONSTRAINT "SupplierChangeEvent_supplierVariantId_fkey" FOREIGN KEY ("supplierVariantId") REFERENCES "SupplierVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiGeneration" ADD CONSTRAINT "AiGeneration_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiGeneration" ADD CONSTRAINT "AiGeneration_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateBucket" ADD CONSTRAINT "RateBucket_supplierAccountId_fkey" FOREIGN KEY ("supplierAccountId") REFERENCES "SupplierAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
