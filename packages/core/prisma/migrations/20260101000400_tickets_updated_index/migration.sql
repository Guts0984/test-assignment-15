-- Search for a very common word walks tickets newest-first and stops after one page, so it needs this order.
CREATE INDEX IF NOT EXISTS tickets_updated_idx ON tickets (updated_at DESC);
