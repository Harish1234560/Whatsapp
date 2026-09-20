-- Least-privilege database role for the marketing backend.
--
-- Run ONCE as the database owner, AFTER `npm run migrate` has created the marketing schema.
-- Then point the backend's DATABASE_URL at this role.
-- Change the password before running. Adjust table names if your schema-mapping.json differs.

CREATE ROLE marketing_app LOGIN PASSWORD 'CHANGE_ME_BEFORE_RUNNING';

-- Its own schema: full rights.
GRANT USAGE ON SCHEMA marketing TO marketing_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA marketing TO marketing_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA marketing TO marketing_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA marketing GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO marketing_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA marketing GRANT USAGE, SELECT ON SEQUENCES TO marketing_app;

-- The store's tables: read only. The backend can never change a customer or an order.
GRANT USAGE ON SCHEMA public TO marketing_app;
GRANT SELECT ON users TO marketing_app;
GRANT SELECT ON orders TO marketing_app;

-- COUPON_MODE=existing_table only: the single write path into the store.
-- It adds marketing coupons to the store's coupon table and can deactivate them on cancel.
-- Remove these two lines when running in COUPON_MODE=api.
GRANT SELECT, INSERT ON coupons TO marketing_app;
GRANT UPDATE ("isActive") ON coupons TO marketing_app;
