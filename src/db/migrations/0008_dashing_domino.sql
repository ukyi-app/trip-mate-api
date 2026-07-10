-- G5(B-1.2): FE 통화 카탈로그는 28종이나 백엔드 seed는 9종뿐이었다 → trips.primary_local_currency/
-- settlement_currency, expenses.local_currency의 FK(→currencies.code)가 19개 FE 선택가능 통화에서 23503→422.
-- 프로덕션 부팅은 runMigrations만 실행하고 seedCurrencies는 호출하지 않으며(src/main.ts), 원본 9통화도
-- 어떤 마이그레이션도 심지 않았다(수동 db:seed CLI로만 투입). 따라서 이 마이그레이션이 부팅 시점의
-- '완전한' 통화 데이터 소스다: 마이그레이션만으로 만들어진 신규/DR/재빌드 DB는 여기서 28종 전부를 얻고,
-- 이미 9(또는 28)종을 보유한 기존 DB는 ON CONFLICT (code) DO NOTHING으로 해당 행을 건너뛴다.
-- 재실행/seedCurrencies 이중삽입 모두 무해(멱등, dup-key 없음). 값은 CURRENCY_SEED(src/db/seed/currencies.ts)와 동일.
-- minor_unit은 실무 거래 관행(런타임 money math의 SSOT). TWD/HUF/IDR는 ISO 지수 2이나 정수만 유통 → minor_unit=0.
INSERT INTO "currencies" ("code", "iso_exponent", "minor_unit", "symbol") VALUES
	('KRW', 0, 0, '₩'),
	('JPY', 0, 0, '¥'),
	('VND', 0, 0, '₫'),
	('TWD', 2, 0, 'NT$'),
	('USD', 2, 2, '$'),
	('EUR', 2, 2, '€'),
	('THB', 2, 2, '฿'),
	('GBP', 2, 2, '£'),
	('CHF', 2, 2, 'Fr'),
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
