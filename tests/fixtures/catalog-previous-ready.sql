-- Isolated query fixture only; intentionally not the Data schema contract.
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA competition;
CREATE SCHEMA fpl;
CREATE TABLE fpl.events(season_id integer,event_id integer,finished boolean,data_checked boolean,data_checked_at timestamptz);
CREATE TABLE competition.tournament_review_heads(season_id integer,tournament_id integer,event_id integer,revision bigint,content_sha256 text);
CREATE TABLE competition.tournament_review_obligations(season_id integer,tournament_id integer,event_id integer,format text,state text,ready_revision bigint);
CREATE TABLE competition.tournament_review_publications(season_id integer,tournament_id integer,event_id integer,revision bigint,content_sha256 text,format text,schema_version text,metric_version text,payload jsonb,expected_subject_count integer,ready_subject_count integer,not_applicable_subject_count integer,row_count integer,event_data_checked_at timestamptz,source_min_checked_at timestamptz,source_max_checked_at timestamptz,published_at timestamptz);
CREATE TABLE competition.tournament_review_publication_chunks(season_id integer,tournament_id integer,event_id integer,revision bigint,section_key text,chunk_index integer,item_count integer,items jsonb,chunk_sha256 text);
