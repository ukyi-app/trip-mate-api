-- G5(B-1.2): FE 통화 카탈로그는 28종이나 백엔드 seed는 9종뿐이었다 → trips.primary_local_currency/
-- settlement_currency, expenses.local_currency의 FK(→currencies.code)가 19개 FE 선택가능 통화에서 23503→422.
-- 프로덕션 부팅은 runMigrations만 실행하고 seedCurrencies는 호출하지 않으므로(src/main.ts), seed 헬퍼 확장만으로는
-- 기존 DB가 9행에 머문다. 이 데이터 마이그레이션이 19개 신규 통화를 멱등 삽입해 부팅 시 자동 적용한다.
-- ON CONFLICT (code) DO NOTHING → 기존 9행 무손상 + 재실행/seedCurrencies 이중삽입 모두 무해(멱등, dup-key 없음).
-- minor_unit은 실무 거래 관행(런타임 money math의 SSOT). HUF/IDR는 ISO 지수 2이나 정수만 유통 → minor_unit=0.
INSERT INTO "currencies" ("code", "iso_exponent", "minor_unit", "symbol") VALUES
	('AED', 2, 2, 'د.إ'),
	('AUD', 2, 2, 'A$'),
	('CAD', 2, 2, 'C$'),
	('CNY', 2, 2, '¥'),
	('CZK', 2, 2, 'Kč'),
	('DKK', 2, 2, 'kr'),
	('HKD', 2, 2, 'HK$'),
	('HUF', 2, 0, 'Ft'),
	('IDR', 2, 0, 'Rp'),
	('INR', 2, 2, '₹'),
	('MOP', 2, 2, 'MOP$'),
	('MYR', 2, 2, 'RM'),
	('NOK', 2, 2, 'kr'),
	('NZD', 2, 2, 'NZ$'),
	('PHP', 2, 2, '₱'),
	('PLN', 2, 2, 'zł'),
	('SEK', 2, 2, 'kr'),
	('SGD', 2, 2, 'S$'),
	('TRY', 2, 2, '₺')
ON CONFLICT ("code") DO NOTHING;
