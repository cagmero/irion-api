-- Migration 0010: REVOLVING credit line columns + loan_draws table

-- Loans table additions
ALTER TABLE loans ADD COLUMN credit_limit bigint;
ALTER TABLE loans ADD COLUMN drawn_amount bigint NOT NULL DEFAULT 0;

-- Draws table: records each draw event
CREATE TABLE loan_draws (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_id uuid NOT NULL REFERENCES loans(id),
    client_request_id varchar(255),
    amount bigint NOT NULL,
    status transaction_status_enum NOT NULL DEFAULT 'pending',
    tx_hash varchar(255),
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX idx_loan_draws_loan ON loan_draws(loan_id);
CREATE INDEX idx_loan_draws_tx_hash ON loan_draws(tx_hash);
