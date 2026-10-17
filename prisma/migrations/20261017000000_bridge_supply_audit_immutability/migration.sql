CREATE OR REPLACE FUNCTION prevent_bridge_supply_reconciliation_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."eventType" = 'BRIDGE_SUPPLY_RECONCILIATION' THEN
      RAISE EXCEPTION 'Bridge supply reconciliation audit records are immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."eventType" = 'BRIDGE_SUPPLY_RECONCILIATION'
     OR NEW."eventType" = 'BRIDGE_SUPPLY_RECONCILIATION' THEN
    RAISE EXCEPTION 'Bridge supply reconciliation audit records are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bridge_supply_reconciliation_immutable
BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW
EXECUTE FUNCTION prevent_bridge_supply_reconciliation_mutation();