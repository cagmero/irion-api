-- Migration 0012: INSTALLMENT loan columns + installments table
ALTER TABLE loans ADD COLUMN installment_interval_rounds integer;

CREATE TABLE installments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_id uuid NOT NULL REFERENCES loans(id),
    installment_index integer NOT NULL,
    due_round bigint NOT NULL,
    principal_portion bigint NOT NULL,
    interest_portion bigint NOT NULL,
    total_amount bigint NOT NULL,
    status varchar(20) NOT NULL DEFAULT 'pending',
    amount_paid bigint NOT NULL DEFAULT 0,
    paid_at_round bigint,
    tx_hash varchar(255),
    created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX idx_installments_loan_index ON installments(loan_id, installment_index);
CREATE UNIQUE INDEX idx_installments_loan_installment ON installments(loan_id, installment_index);
