from typing import Union

def to_checksum_address(address: str) -> str: ...

def remove_0x_prefix(hex_string: str) -> str: ...

def is_address(address: Union[str, bytes]) -> bool: ...