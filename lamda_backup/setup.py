from setuptools import setup
from Cython.Build import cythonize

# 💡 보호할 핵심 자산(파이썬 파일) 목록
target_files = [
    "api_lambda.py",
    "daily_settlement.py",
    "data_archiver.py",
    "fatigue_analysis.py",
    "firehose_transformer.py",
    "hourly_aggregator.py",
    "init_db.py",
    "realtime_detector.py",
    "recommendation_engine.py"
]

setup(
    ext_modules=cythonize(
        target_files, 
        compiler_directives={
            'language_level': "3",
            'emit_code_comments': False  # 💡 C 파일 생성 시 파이썬 주석 포함 안 함
        }
    ),
    script_args=["build_ext", "--inplace"]
)