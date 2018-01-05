# -*- coding: utf-8 -*-
from promise import is_thenable


def depromise_subscription(next, root, info, **kwargs):
    result = next(root, info, **kwargs)
    if info.operation.operation == 'subscription' and is_thenable(result):
        return result.get()
    return result
