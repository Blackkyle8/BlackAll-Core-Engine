-- =============================================================================
-- 0150 · pgvector
-- 사양서 §3(벡터 검색 pgvector 0.8.0 HNSW), §8 1주차
--
-- requires: pgvector
--   이 파일은 pgvector 확장이 없는 환경(로컬 검증용 순정 PostgreSQL)에서는
--   scripts/run-migrations.sh 가 자동으로 건너뛴다.
--   Supabase 프로젝트에서는 반드시 적용되어야 한다.
--
-- 실제 문서/청크 테이블(reference.documents, reference.doc_chunks)과 HNSW 인덱스는
-- 3주차 산출물이다. 여기서는 확장 설치만 한다.
-- =============================================================================

create extension if not exists vector with schema extensions;
